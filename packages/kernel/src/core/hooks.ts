import { LoomError } from "./errors.js";
import type { RankOf } from "./hook-order.js";
import { arrange } from "./hook-order.js";
import type { Runtime, Tap, TapFn } from "./hook-run.js";
import { ChainRun, report } from "./hook-run.js";
import type { HookRef, Next, TapOptions } from "./types.js";

/**
 * Complexity: a hook is ordered by one O(n log n) pass over its taps. Taps without constraints
 * added to an already ordered, constraint-free hook are binary-inserted instead (O(log n) search
 * plus one array copy), so a plugin that taps and runs a shared hook in `setup` stays cheap; any
 * constrained tap, removal or rank change recomputes the hook from scratch.
 */

/** A tap as introspection shows it: a copy, so callers can neither reorder nor reach the handler. */
interface TapInfo {
  readonly owner: string;
  readonly priority: number;
}

/** Tap options plus the plugin the tap belongs to. */
interface OwnedTapOptions<C> extends TapOptions<C> {
  readonly owner: string;
}

export interface HookRegistry {
  /** Returns an idempotent remover for exactly this tap. */
  tap<C, R>(hook: HookRef<C, R>, opts: OwnedTapOptions<C>, fn: (ctx: C, next: Next<C, R>) => R): () => void;
  run<C, R>(hook: HookRef<C, R>, ctx: C, fallback: (ctx: C) => R): R;
  removeOwner(owner: string): void;
  /** Snapshots of the taps in execution order, for introspection. */
  taps(hook: HookRef<unknown, unknown>): readonly TapInfo[];
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
  readonly onError: (err: LoomError) => void;
  /** Breaks ties after priority (lower first) before registration order; absent, only registration order. */
  readonly rankOf?: (owner: string) => number;
}

interface HookState {
  readonly id: string;
  /** In registration order; a Set so removing one tap is O(1). */
  readonly taps: Set<Tap>;
  /** Immutable snapshot, replaced (never mutated) on recompute so in-flight runs keep their view. */
  ordered: readonly Tap[];
  /** Owner pairs with a contradiction dropped by the last computation, so each is reported once. */
  dropped: ReadonlySet<string>;
  /** Owner ranks seen by the last full computation; incremental inserts compare against these. */
  ranks: Map<string, number>;
  /** How many taps declare before/after; zero means `ordered` is a plain sort. */
  constrained: number;
  /** Taps changed since `ordered` was computed (only while a batch is open). */
  stale: boolean;
}

const EMPTY: readonly Tap[] = [];

/** Unordered owner pair: a contradiction is the same one whichever edge the ranks make us drop. */
const pairKey = (a: string, b: string): string => (a < b ? `${a}\0${b}` : `${b}\0${a}`);

/**
 * Recomputes the order of one hook; reports each contradictory owner pair once while it exists.
 * The new state is stored before reporting, so a tap added from `onError` sees (and extends) it.
 */
function refreshOrder(rt: Runtime, state: HookState, rankOf: RankOf | undefined): void {
  const ranks = new Map<string, number>();
  const seenRank: RankOf | undefined =
    rankOf &&
    ((owner) => {
      const r = rankOf(owner);
      ranks.set(owner, r);
      return r;
    });
  const { order, dropped } = arrange([...state.taps], seenRank);
  const previous = state.dropped;
  const fresh = new Map<string, readonly [Tap, Tap]>();
  for (const [holder, other] of dropped.values())
    fresh.set(pairKey(holder.owner, other.owner), [holder, other]);
  state.dropped = new Set(fresh.keys());
  state.ordered = order;
  state.ranks = ranks;
  state.stale = false;
  for (const [key, [holder, other]] of fresh) {
    if (previous.has(key)) continue;
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
}

const isConstrained = (t: Tap): boolean => t.before.length > 0 || t.after.length > 0;

/** Binary-inserts a constraint-free `tap` (newest registration) into the plain-sorted order. */
function insertSorted(state: HookState, tap: Tap, rankOf: RankOf | undefined): void {
  const rank = state.ranks.get(tap.owner) ?? rankOf?.(tap.owner) ?? 0;
  state.ranks.set(tap.owner, rank);
  const list = state.ordered;
  // first position whose tap sorts strictly after the new one; the newest seq goes behind equals
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const t = list[mid] as Tap;
    const isAfter =
      t.priority < tap.priority ||
      (t.priority === tap.priority && (state.ranks.get(t.owner) ?? 0) > rank);
    if (isAfter) hi = mid;
    else lo = mid + 1;
  }
  const next = list.slice();
  next.splice(lo, 0, tap);
  state.ordered = next;
}

interface Ordering {
  /** After taps of `state` changed: order it now, or (inside a batch) mark it stale. Drops an empty hook. */
  readonly changed: (state: HookState) => void;
  /** After `tap` joined `state`: like `changed`, but binary-inserts when the order is a plain sort. */
  readonly added: (state: HookState, tap: Tap) => void;
  /** The current order of `state`, computing it first if stale. */
  readonly settled: (state: HookState | undefined) => readonly Tap[];
  readonly defer: () => () => void;
}

function createOrdering(
  rt: Runtime,
  hooks: Map<string, HookState>,
  rankOf: RankOf | undefined,
): Ordering {
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
  const changed = (state: HookState): void => {
    if (state.taps.size === 0) {
      // only the registered state of a hook id can hold taps
      hooks.delete(state.id);
      stale.delete(state);
    } else if (batches === 0) refreshOrder(rt, state, rankOf);
    else {
      state.stale = true;
      stale.add(state);
    }
  };
  return {
    changed,
    added: (state, tap) => {
      // `tap` is already counted in `constrained`, so zero means it has no constraints either
      if (batches === 0 && !state.stale && state.constrained === 0 && state.dropped.size === 0) {
        insertSorted(state, tap, rankOf);
      } else changed(state);
    },
    settled,
    defer: () => {
      batches++;
      let isOpen = true;
      return () => {
        if (!isOpen) return;
        isOpen = false;
        if (--batches > 0) return;
        for (const state of [...stale]) settled(state);
      };
    },
  };
}

function newTap<C, R>(
  at: { readonly hookId: string; readonly seq: number },
  o: OwnedTapOptions<C>,
  fn: (ctx: C, next: Next<C, R>) => R,
): Tap {
  return {
    hookId: at.hookId,
    owner: o.owner,
    priority: o.priority ?? 0,
    before: o.before ?? [],
    after: o.after ?? [],
    match: o.match as ((ctx: unknown) => boolean) | undefined,
    fn: fn as unknown as TapFn,
    seq: at.seq,
  };
}

export function createHookRegistry(opts: HookRegistryOptions): HookRegistry {
  const rt: Runtime = {
    onError: opts.onError,
    passthrough: new WeakSet(),
  };
  const hooks = new Map<string, HookState>();
  /** Owner -> its taps, so removing an owner touches only those. */
  const byOwner = new Map<string, Set<Tap>>();
  const { changed, added, settled, defer } = createOrdering(rt, hooks, opts.rankOf);
  let seq = 0;

  return {
    tap<C, R>(hook: HookRef<C, R>, o: OwnedTapOptions<C>, fn: (ctx: C, next: Next<C, R>) => R): () => void {
      const { owner } = o;
      let state = hooks.get(hook.id);
      if (state === undefined) {
        state = {
          id: hook.id,
          taps: new Set(),
          ordered: EMPTY,
          dropped: new Set(),
          ranks: new Map(),
          constrained: 0,
          stale: false,
        };
        hooks.set(hook.id, state);
      }
      const tap = newTap({ hookId: hook.id, seq: seq++ }, o, fn);
      state.taps.add(tap);
      if (isConstrained(tap)) state.constrained++;
      let owned = byOwner.get(owner);
      if (!owned) byOwner.set(owner, (owned = new Set()));
      owned.add(tap);
      added(state, tap);
      const home = state;
      return () => {
        if (!home.taps.delete(tap)) return;
        if (isConstrained(tap)) home.constrained--;
        owned.delete(tap);
        // a registered tap's owner set is still the indexed one
        if (owned.size === 0) byOwner.delete(owner);
        changed(home);
      };
    },
    run<C, R>(hook: HookRef<C, R>, ctx: C, fallback: (ctx: C) => R): R {
      const list = settled(hooks.get(hook.id));
      return new ChainRun(rt, hook, fallback as (ctx: unknown) => unknown).run(list, ctx) as R;
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
        if (isConstrained(tap)) state.constrained--;
        touched.add(state);
      }
      for (const state of touched) changed(state);
    },
    taps(hook: HookRef<unknown, unknown>): readonly TapInfo[] {
      return settled(hooks.get(hook.id)).map((t) => ({ owner: t.owner, priority: t.priority }));
    },
    reorder(): void {
      for (const state of hooks.values()) changed(state);
    },
    defer,
  };
}
