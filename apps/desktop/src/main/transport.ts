import type { Transport } from "@loom/kernel";
import type { MessagePortMain } from "electron";

/** The rpc transport over the main end of a MessageChannelMain; closes when the peer's port closes. */
export function createMainTransport(port: MessagePortMain): Transport {
  const closers = new Set<() => void>();
  const closed = (): void => {
    for (const cb of [...closers]) cb();
  };
  port.on("close", closed);
  return {
    send: (msg) => {
      port.postMessage(msg);
    },
    onMessage: (cb) => {
      const listener = (event: { data: unknown }): void => {
        cb(event.data);
        // the endpoint handles `bye` as a close; main's link needs to know as well
        if ((event.data as { type?: unknown } | null)?.type === "bye") closed();
      };
      port.on("message", listener);
      port.start();
      return () => {
        port.off("message", listener);
      };
    },
    onClose: (cb) => {
      closers.add(cb);
      return () => {
        closers.delete(cb);
      };
    },
  };
}
