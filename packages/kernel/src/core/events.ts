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
  readonly owner: string;
  readonly listener: (payload: unknown) => void;
  readonly seq: number;
  removed: boolean;
}

/**
 * Synchronous, owner-scoped event bus. Per-type arrays are copy-on-write, so an
 * emit iterates a stable snapshot; `removed` guards entries dropped mid-emit.
 */
export function createEventBus(opts: EventBusOptions): EventBus {
  const byType = new Map<string, readonly Subscription[]>();
  const { rankOf } = opts;
  let seq = 0;
  const sorted = (list: readonly Subscription[]): readonly Subscription[] =>
    rankOf ? list.slice().sort((a, b) => rankOf(a.owner) - rankOf(b.owner) || a.seq - b.seq) : list;

  function drop(type: string, keep: (s: Subscription) => boolean): void {
    const list = byType.get(type);
    if (!list) return;
    const next = list.filter(keep);
    if (next.length === 0) byType.delete(type);
    else if (next.length !== list.length) byType.set(type, next);
  }

  return {
    on(type, owner, listener) {
      const sub: Subscription = {
        owner,
        listener: listener as (payload: unknown) => void,
        seq: seq++,
        removed: false,
      };
      byType.set(type, sorted([...(byType.get(type) ?? []), sub]));
      return () => {
        if (sub.removed) return;
        sub.removed = true;
        drop(type, (s) => s !== sub);
      };
    },

    emit(type, payload) {
      const snapshot = byType.get(type);
      if (!snapshot) return;
      let sinkFailures: unknown[] | undefined;
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
      if (sinkFailures?.length === 1) throw sinkFailures[0];
      if (sinkFailures && sinkFailures.length > 1) {
        throw new AggregateError(
          sinkFailures,
          `${String(sinkFailures.length)} event error handlers failed`,
        );
      }
    },

    reorder(): void {
      for (const [type, list] of [...byType]) byType.set(type, sorted(list));
    },

    removeOwner(owner: string): void {
      for (const [type, list] of [...byType]) {
        for (const sub of list) if (sub.owner === owner) sub.removed = true;
        drop(type, (s) => !s.removed);
      }
    },
  };
}
