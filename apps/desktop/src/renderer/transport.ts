import type { Transport } from "@loom/kernel";

/** The rpc transport over the renderer end of the MessagePort that main sent through the preload. */
export function createPortTransport(port: MessagePort): Transport {
  return {
    send: (msg) => {
      port.postMessage(msg);
    },
    onMessage: (cb) => {
      const listener = (event: MessageEvent): void => {
        cb(event.data as never);
      };
      port.addEventListener("message", listener);
      port.start();
      return () => {
        port.removeEventListener("message", listener);
      };
    },
    // a DOM MessagePort reports no close of its own; the endpoint's `bye` ends the session
    onClose: (cb) => {
      port.addEventListener("close", cb);
      return () => {
        port.removeEventListener("close", cb);
      };
    },
  };
}
