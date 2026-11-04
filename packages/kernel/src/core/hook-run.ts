import { LoomError } from "./errors.js";
import type { HookRef, Next } from "./types.js";

export type TapFn = (ctx: unknown, next: Next<unknown, unknown>) => unknown;

export interface Tap {
  readonly hookId: string;
  readonly owner: string;
  readonly priority: number;
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly match: ((ctx: unknown) => boolean) | undefined;
  readonly fn: TapFn;
  readonly seq: number;
}

export interface Runtime {
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

export function report(rt: Runtime, err: LoomError): LoomError {
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

export function runChain(
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
