import { AgentRegistryRef } from "@loom/plugin-acp";
import type { Kernel } from "@loom/kernel";

/**
 * Test hook: `LOOM_AGENT_COMMAND="node /abs/agent.mjs"` replaces the `claude-code` agent.
 * `node` runs the app's own binary as Node, so no `node` on PATH is needed.
 */
export function overrideAgent(kernel: Kernel, command: string | undefined): void {
  const [bin, ...args] = (command ?? "").split(/\s+/).filter((part) => part !== "");
  if (bin === undefined) return;
  const isNode = bin === "node";
  kernel.services.use(AgentRegistryRef).add({
    id: "claude-code",
    title: "Claude Code",
    command: isNode ? process.execPath : bin,
    args,
    ...(isNode ? { env: { ELECTRON_RUN_AS_NODE: "1" } } : {}),
  });
}
