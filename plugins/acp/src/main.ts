import type { PluginDefinition } from "@loom/sdk";
import { definePlugin } from "@loom/sdk";

import { AgentRegistryRef, SessionsRef } from "./api.js";
import { launchProcess } from "./main/process.js";
import { createAgentRegistry } from "./main/registry.js";
import { createSessions } from "./main/sessions.js";

const plugin: PluginDefinition = definePlugin({
  id: "acp",
  version: "0.1.0",
  setup(ctx) {
    const agents = createAgentRegistry();
    const service = createSessions({
      agents,
      run: (hook, c, fb) => ctx.run(hook, c, fb),
      launch: launchProcess,
    });
    ctx.provide(AgentRegistryRef, agents);
    // only the Sessions methods are exposed over rpc, not `dispose`
    ctx.provide(SessionsRef, {
      ensure: (o) => service.ensure(o),
      prompt: (s, t) => service.prompt(s, t),
      cancel: (s) => service.cancel(s),
      respondPermission: (s, i, o) => service.respondPermission(s, i, o),
      waitUpdates: (s, a, t) => service.waitUpdates(s, a, t),
      close: (s) => service.close(s),
    });
    ctx.onDispose(() => service.dispose());
  },
});

export default plugin;
