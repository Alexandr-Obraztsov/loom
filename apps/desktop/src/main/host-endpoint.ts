import type { RpcEndpoint, RpcHandler } from "@loom/sdk";
import { LoomError } from "@loom/sdk";

export interface SwitchableEndpoint {
  /** What main plugins see as `HostRef.endpoint`: always talks to the current window page. */
  readonly endpoint: RpcEndpoint;
  /** Makes `peer` the current page; returns a function that detaches it. */
  attach(peer: RpcEndpoint): () => void;
}

/** One stable endpoint for the main kernel over page loads that each get their own rpc endpoint. */
export function createSwitchableEndpoint(): SwitchableEndpoint {
  const handlers = new Map<string, RpcHandler>();
  let current: { peer: RpcEndpoint; removers: (() => void)[] } | undefined;
  return {
    endpoint: {
      call: (...args) =>
        current
          ? current.peer.call(...args)
          : Promise.reject(new LoomError("RPC_DISCONNECTED", "No window page is connected")),
      handle: (target, impl) => {
        if (handlers.has(target)) {
          throw new LoomError("SERVICE_CONFLICT", `RPC target "${target}" already has a handler`);
        }
        handlers.set(target, impl);
        current?.removers.push(current.peer.handle(target, impl));
        return () => {
          handlers.delete(target);
        };
      },
      close: () => undefined,
    },
    attach(peer) {
      const entry = { peer, removers: [...handlers].map(([t, h]) => peer.handle(t, h)) };
      current = entry;
      return () => {
        for (const remove of entry.removers) remove();
        if (current === entry) current = undefined;
      };
    },
  };
}
