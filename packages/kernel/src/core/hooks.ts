import { LoomError } from "./errors.js";
import { arrange } from "./hook-order.js";
import type { RankOf } from "./hook-order.js";
import { report, runChain } from "./hook-run.js";
import type { Runtime, Tap, TapFn } from "./hook-run.js";
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
  /**
   * Batches order recomputation: until the returned function is called (calls nest), tap, removal
   * and reorder only mark hooks stale, and each stale hook is ordered once, on its next `run` or
   * `taps` or when the outermost batch ends. A contradiction that exists only inside the batch is
   * never reported. Ordering n taps one by one costs O(n² log n); batched it is O(n log n).
   */
  defer(): () => void;
}

export interface HookRegistryOptions {
  onError(err: LoomError): void;
  /** Breaks ties after priority (lower first) before registration order; absent, only registration order. */
  readonly rankOf?: (owner: string) => number;
}

interface HookState {
  readonly id: string;
  /** In registration order; a Set so removing one tap is O(1). */
  readonly taps: Set<Tap>;
  /** Immutable snapshot, replaced (never mutated) on recompute so in-flight runs keep their view. */
  ordered: readonly Tap[];
  /** Keys of edges dropped by the last computation, so each contradiction is reported once. */
  dropped: ReadonlySet<string>;
  /** Taps changed since `ordered` was computed (only while a batch is open). */
  stale: boolean;
}

const EMPTY: readonly Tap[] = [];

/** Recomputes the order of one hook; reports each newly dropped contradictory constraint once. */
function refreshOrder(rt: Runtime, state: HookState, rankOf: RankOf | undefined): void {
  const { order, dropped } = arrange([...state.taps], rankOf);
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
  state.stale = false;
}

interface Ordering {
  /** After taps of `state` changed: order it now, or (inside a batch) mark it stale. Drops an empty hook. */
  readonly changed: (state: HookState) => void;
  /** The current order of `state`, computing it first if stale. */
  readonly settled: (state: HookState | undefined) => readonly Tap[];
  readonly defer: () => () => void;
}

function createOrdering(rt: Runtime, hooks: Map<string, HookState>, rankOf: RankOf | undefined): Ordering {
  const stale = new Set<HookState>();
  let batches = 0;
  const settled = (state: HookState | undefined): readonly Tap[] => {
    if (state === undefined) return EMPTY;
    if (state.stale) {
      stale.delete(state);
      refreshOrder(rt, state, rankOf);
    }
    return state.ordered;
  };
  return {
    changed: (state) => {
      if (state.taps.size === 0) {
        // only the registered state of a hook id can hold taps
        hooks.delete(state.id);
        stale.delete(state);
      } else if (batches === 0) refreshOrder(rt, state, rankOf);
      else {
        state.stale = true;
        stale.add(state);
      }
    },
    settled,
    defer: () => {
      batches++;
      let open = true;
      return () => {
        if (!open) return;
        open = false;
        if (--batches > 0) return;
        for (const state of [...stale]) settled(state);
      };
    },
  };
}

function newTap<C, R>(hookId: string, owner: string, o: TapOptions<C>, fn: (ctx: C, next: Next<C, R>) => R, seq: number): Tap {
  return {
    hookId,
    owner,
    priority: o.priority ?? 0,
    before: o.before ?? [],
    after: o.after ?? [],
    match: o.match as ((ctx: unknown) => boolean) | undefined,
    fn: fn as unknown as TapFn,
    seq,
  };
}

export function createHookRegistry(opts: HookRegistryOptions): HookRegistry {
  const rt: Runtime = {
    onError: (err) => {
      opts.onError(err);
    },
    passthrough: new WeakSet(),
  };
  const hooks = new Map<string, HookState>();
  /** Owner -> its taps, so removing an owner touches only those. */
  const byOwner = new Map<string, Set<Tap>>();
  const { changed, settled, defer } = createOrdering(rt, hooks, opts.rankOf);
  let seq = 0;

  return {
    tap<C, R>(
      hook: HookRef<C, R>,
      owner: string,
      o: TapOptions<C>,
      fn: (ctx: C, next: Next<C, R>) => R,
    ): () => void {
      let state = hooks.get(hook.id);
      if (state === undefined) {
        state = { id: hook.id, taps: new Set(), ordered: EMPTY, dropped: new Set(), stale: false };
        hooks.set(hook.id, state);
      }
      const tap = newTap(hook.id, owner, o, fn, seq++);
      state.taps.add(tap);
      let owned = byOwner.get(owner);
      if (!owned) byOwner.set(owner, (owned = new Set()));
      owned.add(tap);
      changed(state);
      const home = state;
      return () => {
        if (!home.taps.delete(tap)) return;
        owned.delete(tap);
        // a registered tap's owner set is still the indexed one
        if (owned.size === 0) byOwner.delete(owner);
        changed(home);
      };
    },
    run<C, R>(hook: HookRef<C, R>, ctx: C, fallback: (ctx: C) => R): R {
      const list = settled(hooks.get(hook.id));
      return runChain(rt, hook, list, ctx, fallback as (ctx: unknown) => unknown) as R;
    },
    removeOwner(owner: string): void {
      const owned = byOwner.get(owner);
      if (!owned) return;
      byOwner.delete(owner);
      const touched = new Set<HookState>();
      for (const tap of owned) {
        // a tap still indexed by its owner is registered, so its hook's state exists
        const state = hooks.get(tap.hookId) as HookState;
        state.taps.delete(tap);
        touched.add(state);
      }
      for (const state of touched) changed(state);
    },
    taps(hook: HookRef<unknown, unknown>): readonly { readonly owner: string }[] {
      return settled(hooks.get(hook.id));
    },
    reorder(): void {
      for (const state of hooks.values()) changed(state);
    },
    defer,
  };
}
