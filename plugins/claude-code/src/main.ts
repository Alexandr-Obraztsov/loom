import { createRequire } from "node:module";

import { AgentRegistryRef } from "@loom/plugin-acp";
import type { PluginDefinition } from "@loom/sdk";
import { definePlugin } from "@loom/sdk";

const require = createRequire(import.meta.url);

/** Registers Claude Code (via the official ACP adapter) as an agent in acp's registry. */
const plugin: PluginDefinition = definePlugin({
  id: "claude-code",
  version: "0.1.0",
  dependsOn: { acp: "^0.1.0" },
  setup(ctx) {
    ctx.use(AgentRegistryRef).add({
      id: "claude-code",
      title: "Claude Code",
      command: process.execPath,
      args: [require.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js")],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
  },
});

export default plugin;
