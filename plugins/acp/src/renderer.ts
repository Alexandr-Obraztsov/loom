import type { PluginDefinition } from "@loom/sdk";
import { definePlugin, HostRef, provideRemoteServices } from "@loom/sdk";

import { AgentRegistryRef, SessionsRef } from "./api.js";

/** Renderer side of acp: proxies the main-side Sessions and AgentRegistry over the host endpoint. */
const plugin: PluginDefinition = definePlugin({
  id: "acp",
  version: "0.1.0",
  setup(ctx) {
    const host = ctx.use(HostRef);
    provideRemoteServices(ctx, { endpoint: host.endpoint, refs: [SessionsRef, AgentRegistryRef] });
  },
});

export default plugin;
