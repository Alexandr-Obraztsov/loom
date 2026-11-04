import { LoomError } from "./errors.js";
import type { HookRef, Next, TapOptions } from "./types.js";

export interface HookRegistry {
  /** Returns an idempotent remover for exactly this tap. */
  tap<C, R>(hook: HookRef<C, R>, owner: string, opts: TapOptions<C>, fn: (ctx: C, next: Next<C, R>) => R): () => void;
  run<C, R>(hook: HookRef<C, R>, ctx: C, fallback: (ctx: C) => R): R;
  removeOwner(owner: string): void;
  /** Taps in execution order, for introspection. */
  taps(hook: HookRef<unknown, unknown>): readonly { readonly owner: string }[];
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
  /** Set when this tap's constraints contradict earlier ones; every edge touching it is dropped. */
  isolated: boolean;
}

interface HookState {
  readonly taps: Tap[];
  /** Immutable snapshot, replaced (never mutated) on add/remove so in-flight runs keep their view. */
  ordered: readonly Tap[];
}

interface Runtime {
  readonly onError: (err: LoomError) => void;
  /** Errors thrown by a fallback: propagate unchanged instead of being blamed on the enclosing tap. */
  readonly fallbackErrors: WeakSet<object>;
}

interface Sorted {
  readonly order: Tap[];
  readonly stuck: Tap[];
}

function compareRank(a: Tap, b: Tap): number {
  return b.priority - a.priority || a.seq - b.seq;
}

/** Kahn's algorithm; among available taps the best (priority desc, then registration) goes first. */
function sortTaps(taps: readonly Tap[]): Sorted {
  const ranked = taps.slice().sort(compareRank);
  const byOwner = new Map<string, Tap[]>();
  const succ = new Map<Tap, Tap[]>();
  const indegree = new Map<Tap, number>();
  for (const t of ranked) {
    byOwner.set(t.owner, [...(byOwner.get(t.owner) ?? []), t]);
    succ.set(t, []);
    indegree.set(t, 0);
  }
  const link = (from: Tap, to: Tap): void => {
    if (from === to || from.isolated || to.isolated) return;
    succ.get(from)?.push(to);
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
  };
  for (const t of ranked) {
    for (const o of t.before) for (const u of byOwner.get(o) ?? []) link(t, u);
    for (const o of t.after) for (const u of byOwner.get(o) ?? []) link(u, t);
  }
  const order: Tap[] = [];
  const placed = new Set<Tap>();
  for (;;) {
    const best = ranked.find((t) => !placed.has(t) && indegree.get(t) === 0);
    if (best === undefined) break;
    placed.add(best);
    order.push(best);
    for (const s of succ.get(best) ?? []) indegree.set(s, (indegree.get(s) ?? 0) - 1);
  }
  return { order, stuck: ranked.filter((t) => !placed.has(t)) };
}

function related(a: Tap, b: Tap): boolean {
  return a.before.includes(b.owner) || a.after.includes(b.owner) || b.before.includes(a.owner) || b.after.includes(a.owner);
}

function contradiction(tap: Tap, stuck: readonly Tap[]): LoomError {
  const partner = stuck.find((u) => u !== tap && related(tap, u)) ?? stuck.find((u) => u !== tap) ?? tap;
  const owners = [...new Set([tap.owner, partner.owner])];
  return new LoomError(
    "TAP_FAILED",
    `Contradictory before/after constraints between "${tap.owner}" and "${partner.owner}" on hook "${tap.hookId}"; constraints of "${tap.owner}" are ignored`,
    { pluginIds: owners },
  );
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    (typeof v === "object" || typeof v === "function") && v !== null && typeof (v as { then?: unknown }).then === "function"
  );
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function report(rt: Runtime, err: LoomError): LoomError {
  try {
    rt.onError(err);
  } catch {
    // a failing error sink must not mask the original failure
  }
  return err;
}

/** Wraps once: TAP_FAILED and fallback errors pass through; everything else becomes TAP_FAILED for `tap`. */
function wrap(rt: Runtime, tap: Tap, e: unknown): unknown {
  if (e instanceof LoomError && e.code === "TAP_FAILED") return e;
  if (typeof e === "object" && e !== null && rt.fallbackErrors.has(e)) return e;
  return report(
    rt,
    new LoomError("TAP_FAILED", `Tap of "${tap.owner}" on hook "${tap.hookId}" failed: ${describe(e)}`, {
      pluginIds: [tap.owner],
      cause: e,
    }),
  );
}

function raise(isAsync: boolean, err: unknown): unknown {
  if (isAsync) return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  throw err;
}

function invoke(rt: Runtime, tap: Tap, ctx: unknown, next: Next<unknown, unknown>, isAsync: boolean): unknown {
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
      new LoomError("TAP_FAILED", `Tap of "${tap.owner}" on sync hook "${tap.hookId}" returned a Promise`, {
        pluginIds: [tap.owner],
      }),
    );
  }
  return result;
}

function callFallback(rt: Runtime, hookId: string, fallback: (ctx: unknown) => unknown, ctx: unknown, isAsync: boolean): unknown {
  const own = (e: unknown): unknown => {
    if (typeof e === "object" && e !== null) rt.fallbackErrors.add(e);
    return e;
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
      new LoomError("TAP_FAILED", `Fallback of sync hook "${hookId}" returned a Promise`, { pluginIds: [] }),
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
          const err = new LoomError("TAP_FAILED", `Tap of "${tap.owner}" on hook "${hook.id}" called next() more than once`, {
            pluginIds: [tap.owner],
          });
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

export function createHookRegistry(opts: { onError(err: LoomError): void }): HookRegistry {
  const rt: Runtime = { onError: (err) => {
      opts.onError(err);
    }, fallbackErrors: new WeakSet() };
  const hooks = new Map<string, HookState>();
  let seq = 0;

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
    else state.ordered = sortTaps(state.taps).order;
  };

  return {
    tap<C, R>(hook: HookRef<C, R>, owner: string, o: TapOptions<C>, fn: (ctx: C, next: Next<C, R>) => R): () => void {
      let state = hooks.get(hook.id);
      if (state === undefined) {
        state = { taps: [], ordered: EMPTY };
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
        isolated: false,
      };
      state.taps.push(tap);
      let sorted = sortTaps(state.taps);
      if (sorted.stuck.length > 0) {
        tap.isolated = true;
        report(rt, contradiction(tap, sorted.stuck));
        sorted = sortTaps(state.taps);
      }
      state.ordered = sorted.order;
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
  };
}
