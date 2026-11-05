import { clone, microtask } from "./platform.js";
import type { Transport } from "./protocol.js";

export interface MemoryTransport extends Transport {
  /** Closes both ends: close listeners of both run synchronously; queued messages are dropped. */
  close(): void;
}

interface Side {
  readonly messages: Set<(message: unknown) => void>;
  readonly closes: Set<() => void>;
}

/**
 * Two connected in-process transports. `send` clones the message with `structuredClone`
 * synchronously (so a non-cloneable payload throws DataCloneError at the sender) and delivers
 * it to the peer in a microtask, preserving order.
 */
export function createMemoryTransportPair(): [MemoryTransport, MemoryTransport] {
  const sides: [Side, Side] = [
    { messages: new Set(), closes: new Set() },
    { messages: new Set(), closes: new Set() },
  ];
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const side of sides) for (const cb of [...side.closes]) cb();
  };
  const end = (own: Side, peer: Side): MemoryTransport => ({
    send(msg) {
      if (closed) return;
      const copy = clone(msg);
      microtask(() => {
        if (closed) return;
        for (const cb of [...peer.messages]) cb(copy);
      });
    },
    onMessage(cb) {
      own.messages.add(cb);
      return () => {
        own.messages.delete(cb);
      };
    },
    onClose(cb) {
      own.closes.add(cb);
      return () => {
        own.closes.delete(cb);
      };
    },
    close,
  });
  return [end(sides[0], sides[1]), end(sides[1], sides[0])];
}
