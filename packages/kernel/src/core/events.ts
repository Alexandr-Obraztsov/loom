import { LoomError } from "./errors.js";

export interface EventBus {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- payload type is the caller's contract
  on<P>(type: string, owner: string, listener: (payload: P) => void): () => void;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- payload type is the caller's contract
  emit<P>(type: string, payload: P): void;
  removeOwner(owner: string): void;
}

interface Subscription {
  readonly owner: string;
  readonly listener: (payload: unknown) => void;
  removed: boolean;
}

/**
 * Synchronous, owner-scoped event bus. Per-type arrays are copy-on-write, so an
 * emit iterates a stable snapshot; `removed` guards entries dropped mid-emit.
 */
export function createEventBus(opts: { onError(err: LoomError): void }): EventBus {
  const byType = new Map<string, readonly Subscription[]>();

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
        removed: false,
      };
      byType.set(type, [...(byType.get(type) ?? []), sub]);
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

    removeOwner(owner: string): void {
      for (const [type, list] of [...byType]) {
        for (const sub of list) if (sub.owner === owner) sub.removed = true;
        drop(type, (s) => !s.removed);
      }
    },
  };
}
