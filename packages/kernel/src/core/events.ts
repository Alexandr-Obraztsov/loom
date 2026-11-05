import { LoomError } from "./errors.js";

export interface EventBus {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- payload type is the caller's contract
  on<P>(type: string, owner: string, listener: (payload: P) => void): () => void;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- payload type is the caller's contract
  emit<P>(type: string, payload: P): void;
  removeOwner(owner: string): void;
  /** Re-sorts every listener list; call after the ranks returned by `rankOf` changed. */
  reorder(): void;
}

export interface EventBusOptions {
  onError(err: LoomError): void;
  /** Delivery order: owner rank (lower first), then subscription order; absent, subscription order only. */
  readonly rankOf?: (owner: string) => number;
}

interface Subscription {
  readonly type: string;
  readonly owner: string;
  readonly listener: (payload: unknown) => void;
  readonly seq: number;
  /** `rankOf(owner)` as of the last subscribe or reorder. */
  rank: number;
  removed: boolean;
}

/**
 * Subscriptions of one type, sorted by (rank, seq); `dead` of them are removed but not yet compacted.
 * `subs` is mutated in place unless an emit may be iterating it (`shared`): then the mutation
 * first moves to a copy (copy-on-write), so subscribing is O(1) amortized and an emit still sees
 * a stable snapshot.
 */
interface Listeners {
  subs: Subscription[];
  dead: number;
  /** Emits currently iterating `subs`. */
  emitting: number;
  /** `subs` may be in use by an emit; copy before the next in-place change. */
  shared: boolean;
}

/** Index of the first entry of `list` (sorted by rank, then seq) ranking after `rank`. */
function insertionPoint(list: readonly Subscription[], rank: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid] as Subscription).rank <= rank) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const byRankThenSeq = (a: Subscription, b: Subscription): number => a.rank - b.rank || a.seq - b.seq;
const alive = (l: Listeners): Subscription[] => (l.dead === 0 ? l.subs : l.subs.filter((s) => !s.removed));

/** Replaces the list by `subs`, which no emit holds. */
function replace(l: Listeners, subs: Subscription[]): void {
  l.subs = subs;
  l.dead = 0;
  l.shared = false;
}

/** Adds the newest subscription after every entry of equal or lower rank (compacting dead entries first). */
function insertInto(byType: Map<string, Listeners>, sub: Subscription): void {
  let l = byType.get(sub.type);
  if (!l) byType.set(sub.type, (l = { subs: [], dead: 0, emitting: 0, shared: false }));
  if (l.dead > 0) replace(l, alive(l));
  else if (l.shared) replace(l, l.subs.slice());
  const at = insertionPoint(l.subs, sub.rank);
  if (at === l.subs.length) l.subs.push(sub);
  else l.subs.splice(at, 0, sub);
}

/** Marks `sub` removed; compacts its list once half of it is dead, dropping an empty list. */
function removeFrom(byType: Map<string, Listeners>, sub: Subscription): void {
  sub.removed = true;
  const l = byType.get(sub.type) as Listeners;
  l.dead++;
  if (l.dead * 2 < l.subs.length) return;
  replace(l, alive(l));
  if (l.subs.length === 0) byType.delete(sub.type);
}

/**
 * Synchronous, owner-scoped event bus. An emit iterates a stable snapshot of its type's list:
 * the list is copied only when it changes while an emit is running; `removed` guards entries
 * dropped mid-emit.
 * Removed entries are compacted lazily (once they are half of a list), so removing
 * every subscriber of one type costs O(n), not O(n²).
 */
export function createEventBus(opts: EventBusOptions): EventBus {
  const byType = new Map<string, Listeners>();
  /** Owner -> its live subscriptions, so removing an owner touches only those. */
  const byOwner = new Map<string, Set<Subscription>>();
  const { rankOf } = opts;
  let seq = 0;

  return {
    on(type, owner, listener) {
      const sub: Subscription = {
        type,
        owner,
        listener: listener as (payload: unknown) => void,
        seq: seq++,
        rank: rankOf ? rankOf(owner) : 0,
        removed: false,
      };
      insertInto(byType, sub);
      let owned = byOwner.get(owner);
      if (!owned) byOwner.set(owner, (owned = new Set()));
      owned.add(sub);
      return () => {
        if (sub.removed) return;
        owned.delete(sub);
        // a live subscription's owner set is still the indexed one
        if (owned.size === 0) byOwner.delete(owner);
        removeFrom(byType, sub);
      };
    },

    emit(type, payload) {
      const l = byType.get(type);
      if (!l) return;
      const snapshot = l.subs;
      l.emitting++;
      l.shared = true;
      let sinkFailures: unknown[] | undefined;
      try {
        for (const sub of snapshot) {
          if (sub.removed) continue;
          try {
            sub.listener(payload);
          } catch (cause) {
            const error = new LoomError(
              "TAP_FAILED",
              `event listener of "${sub.owner}" for "${type}" failed`,
              { pluginIds: [sub.owner], details: { type }, cause },
            );
            try {
              opts.onError(error);
            } catch (sinkError) {
              (sinkFailures ??= []).push(sinkError);
            }
          }
        }
      } finally {
        if (--l.emitting === 0) l.shared = false;
      }
      if (sinkFailures?.length === 1) throw sinkFailures[0];
      if (sinkFailures && sinkFailures.length > 1) {
        throw new AggregateError(
          sinkFailures,
          `${String(sinkFailures.length)} event error handlers failed`,
        );
      }
    },

    reorder(): void {
      if (!rankOf) return;
      for (const l of byType.values()) {
        const list = alive(l).slice();
        for (const sub of list) sub.rank = rankOf(sub.owner);
        replace(l, list.sort(byRankThenSeq));
      }
    },

    removeOwner(owner: string): void {
      const owned = byOwner.get(owner);
      if (!owned) return;
      byOwner.delete(owner);
      for (const sub of owned) removeFrom(byType, sub);
    },
  };
}
