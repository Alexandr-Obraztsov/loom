import { LoomError } from "./errors.js";
import { arrange } from "./hook-order.js";
import type { HookRef, Next, TapOptions } from "./types.js";

export interface HookRegistry {
  /** Returns an idempotent remover for exactly this tap. */
  tap<C, R>(
    hook: HookRef<C, R>,
    owner: string,
    opts: TapOptions<C>,
    fn: (ctx: C, next: Next<C, R>) => R,
  ): () => void;
  run<C, R>(hook: HookRef<C, R>, ctx: C, fallback: (ctx: C) => R): R;
  removeOwner(owner: string): void;
  /** Taps in execution order, for introspection. */
  taps(hook: HookRef<unknown, unknown>): readonly { readonly owner: string }[];
  /** Recomputes every hook's order; call after the ranks returned by `rankOf` changed. */
  reorder(): void;
}

export interface HookRegistryOptions {
  onError(err: LoomError): void;
  /** Breaks ties after priority (lower first) before registration order; absent, only registration order. */
  readonly rankOf?: (owner: string) => number;
}

type TapFn = (ctx: unknown, next: Next<unknown, unknown>) => unknown;

interface Tap {
  readonly hookId: string;
  readonly owner: string;
  readonly priority: number;
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly match: ((ctx: unknown) => boolean) | undefined;
  readonly fn: TapFn;
  readonly seq: number;
}

interface HookState {
  readonly taps: Tap[];
  /** Immutable snapshot, replaced (never mutated) on add/remove so in-flight runs keep their view. */
  ordered: readonly Tap[];
  /** Keys of edges dropped by the last computation, so each contradiction is reported once. */
  dropped: ReadonlySet<string>;
}

interface Runtime {
  readonly onError: (err: LoomError) => void;
  /** Registry-made TAP_FAILED errors and fallback errors: they propagate by identity, never re-wrapped. */
  readonly passthrough: WeakSet<object>;
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    (typeof v === "object" || typeof v === "function") &&
    v !== null &&
    typeof (v as { then?: unknown }).then === "function"
  );
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function report(rt: Runtime, err: LoomError): LoomError {
  rt.passthrough.add(err);
  try {
    rt.onError(err);
  } catch {
    // a failing error sink must not mask the original failure
  }
  return err;
}

/** Wraps once: registry-made TAP_FAILED and fallback errors pass through (by identity); everything else becomes TAP_FAILED for `tap`. */
function wrap(rt: Runtime, tap: Tap, e: unknown): unknown {
  if (typeof e === "object" && e !== null && rt.passthrough.has(e)) return e;
  return report(
    rt,
    new LoomError(
      "TAP_FAILED",
      `Tap of "${tap.owner}" on hook "${tap.hookId}" failed: ${describe(e)}`,
      {
        pluginIds: [tap.owner],
        cause: e,
      },
    ),
  );
}

function raise(isAsync: boolean, err: unknown): unknown {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- re-raises the original value
  if (isAsync) return Promise.reject(err);
  throw err;
}

function invoke(
  rt: Runtime,
  tap: Tap,
  ctx: unknown,
  next: Next<unknown, unknown>,
  isAsync: boolean,
): unknown {
  let result: unknown;
  try {
    result = tap.fn(ctx, next);
  } catch (e) {
    return raise(isAsync, wrap(rt, tap, e));
  }
  if (isAsync) {
    if (!isThenable(result)) return result;
    return Promise.resolve(result).then(undefined, (e: unknown) => {
      throw wrap(rt, tap, e);
    });
  }
  if (isThenable(result)) {
    if (result instanceof Promise) result.catch(() => undefined);
    throw report(
      rt,
      new LoomError(
        "TAP_FAILED",
        `Tap of "${tap.owner}" on sync hook "${tap.hookId}" returned a Promise`,
        {
          pluginIds: [tap.owner],
        },
      ),
    );
  }
  return result;
}

function callFallback(
  rt: Runtime,
  hookId: string,
  fallback: (ctx: unknown) => unknown,
  ctx: unknown,
  isAsync: boolean,
): unknown {
  const own = (e: unknown): Error => {
    const err =
      typeof e === "object" && e !== null
        ? e
        : new Error("Fallback threw a non-object value", { cause: e });
    rt.passthrough.add(err);
    return err as Error;
  };
  let result: unknown;
  try {
    result = fallback(ctx);
  } catch (e) {
    return raise(isAsync, own(e));
  }
  if (isAsync) {
    if (!isThenable(result)) return result;
    return Promise.resolve(result).then(undefined, (e: unknown) => {
      throw own(e);
    });
  }
  if (isThenable(result)) {
    if (result instanceof Promise) result.catch(() => undefined);
    throw report(
      rt,
      new LoomError("TAP_FAILED", `Fallback of sync hook "${hookId}" returned a Promise`, {
        pluginIds: [],
      }),
    );
  }
  return result;
}

function runChain(
  rt: Runtime,
  hook: HookRef<unknown, unknown>,
  list: readonly Tap[],
  ctx: unknown,
  fallback: (ctx: unknown) => unknown,
): unknown {
  const isAsync = hook.mode === "async";
  const step = (from: number, c: unknown): unknown => {
    for (let i = from; i < list.length; i++) {
      const tap = list[i];
      if (tap === undefined) break;
      if (tap.match !== undefined) {
        try {
          if (!tap.match(c)) continue;
        } catch (e) {
          return raise(isAsync, wrap(rt, tap, e));
        }
      }
      let called = false;
      const next: Next<unknown, unknown> = (nextCtx) => {
        if (called) {
          const err = new LoomError(
            "TAP_FAILED",
            `Tap of "${tap.owner}" on hook "${hook.id}" called next() more than once`,
            {
              pluginIds: [tap.owner],
            },
          );
          return raise(isAsync, report(rt, err));
        }
        called = true;
        return step(i + 1, nextCtx);
      };
      return invoke(rt, tap, c, next, isAsync);
    }
    return callFallback(rt, hook.id, fallback, c, isAsync);
  };
  return step(0, ctx);
}

const EMPTY: readonly Tap[] = [];

/** Recomputes the order of one hook; reports each newly dropped contradictory constraint once. */
function refreshOrder(rt: Runtime, state: HookState, rankOf: ((owner: string) => number) | undefined): void {
  const { order, dropped } = arrange(state.taps, rankOf);
  for (const [key, [holder, other]] of dropped) {
    if (state.dropped.has(key)) continue;
    const owners = [...new Set([holder.owner, other.owner])];
    report(
      rt,
      new LoomError(
        "TAP_FAILED",
        `Contradictory before/after constraints between "${holder.owner}" and "${other.owner}" on hook "${holder.hookId}"; the constraint is ignored`,
        { pluginIds: owners },
      ),
    );
  }
  state.dropped = new Set(dropped.keys());
  state.ordered = order;
}

export function createHookRegistry(opts: HookRegistryOptions): HookRegistry {
  const rt: Runtime = {
    onError: (err) => {
      opts.onError(err);
    },
    passthrough: new WeakSet(),
  };
  const hooks = new Map<string, HookState>();
  let seq = 0;
  const rankOf = opts.rankOf;

  const refresh = (state: HookState): void => {
    refreshOrder(rt, state, rankOf);
  };

  const detach = (state: HookState, id: string, match: (t: Tap) => boolean): void => {
    let changed = false;
    for (let i = state.taps.length - 1; i >= 0; i--) {
      const t = state.taps[i];
      if (t !== undefined && match(t)) {
        state.taps.splice(i, 1);
        changed = true;
      }
    }
    if (!changed) return;
    if (state.taps.length === 0) hooks.delete(id);
    else refresh(state);
  };

  return {
    tap<C, R>(
      hook: HookRef<C, R>,
      owner: string,
      o: TapOptions<C>,
      fn: (ctx: C, next: Next<C, R>) => R,
    ): () => void {
      let state = hooks.get(hook.id);
      if (state === undefined) {
        state = { taps: [], ordered: EMPTY, dropped: new Set() };
        hooks.set(hook.id, state);
      }
      const tap: Tap = {
        hookId: hook.id,
        owner,
        priority: o.priority ?? 0,
        before: o.before ?? [],
        after: o.after ?? [],
        match: o.match as ((ctx: unknown) => boolean) | undefined,
        fn: fn as unknown as TapFn,
        seq: seq++,
      };
      state.taps.push(tap);
      refresh(state);
      const owned = state;
      return () => {
        detach(owned, hook.id, (t) => t === tap);
      };
    },
    run<C, R>(hook: HookRef<C, R>, ctx: C, fallback: (ctx: C) => R): R {
      const list = hooks.get(hook.id)?.ordered ?? EMPTY;
      return runChain(rt, hook, list, ctx, fallback as (ctx: unknown) => unknown) as R;
    },
    removeOwner(owner: string): void {
      for (const [id, state] of [...hooks]) detach(state, id, (t) => t.owner === owner);
    },
    taps(hook: HookRef<unknown, unknown>): readonly { readonly owner: string }[] {
      return hooks.get(hook.id)?.ordered ?? EMPTY;
    },
    reorder(): void {
      for (const state of hooks.values()) refresh(state);
    },
  };
}
