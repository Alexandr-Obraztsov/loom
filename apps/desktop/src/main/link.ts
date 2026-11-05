import type { Kernel, RpcEndpoint } from "@loom/kernel";
import { createRpcEndpoint, exposeServices } from "@loom/kernel";
import { AgentRegistryRef, SessionsRef } from "@loom/plugin-acp";
import type { MessageChannelMain, MessagePortMain } from "electron";

import type { SwitchableEndpoint } from "./host-endpoint.js";
import { createMainTransport } from "./transport.js";
import type { TurnGuard } from "./turn-guard.js";

export interface LinkDeps {
  readonly kernel: Kernel;
  readonly host: SwitchableEndpoint;
  readonly guard: TurnGuard;
  readonly channel: () => MessageChannelMain;
  /** Delivers the page's end of the channel. */
  send(port: MessagePortMain): void;
}

export interface Link {
  /** A page loaded: new channel, new endpoint, services exposed. */
  open(): void;
  /** The page is gone (close, reload, crash): tears the connection down and cancels running turns. */
  close(): void;
}

/** The connection between the main kernel and the one page that is currently loaded. */
export function createLink(deps: LinkDeps): Link {
  let current: { endpoint: RpcEndpoint; port: MessagePortMain; stop(): void } | undefined;
  const link: Link = {
    open() {
      link.close();
      const { port1, port2 } = deps.channel();
      const transport = createMainTransport(port1);
      const endpoint = createRpcEndpoint(transport);
      const stopServing = exposeServices(deps.kernel, endpoint, [SessionsRef, AgentRegistryRef]);
      const detach = deps.host.attach(endpoint);
      const entry = {
        endpoint,
        port: port1,
        stop: () => {
          stopServing();
          detach();
        },
      };
      current = entry;
      // the page closed its end (`bye`) or vanished
      transport.onClose(() => {
        if (current === entry) link.close();
      });
      deps.send(port2);
    },
    close() {
      const entry = current;
      if (!entry) return;
      current = undefined;
      entry.stop();
      entry.endpoint.close();
      entry.port.close();
      void deps.guard.cancelRunning();
    },
  };
  return link;
}
