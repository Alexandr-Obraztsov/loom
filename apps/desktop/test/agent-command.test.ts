import { describe, expect, it } from "vitest";
import { createKernel } from "@loom/kernel";
import { definePlugin } from "@loom/sdk";
import { AgentRegistryRef } from "@loom/plugin-acp";
import type { AgentSpec } from "@loom/plugin-acp";
import { overrideAgent } from "../src/main/agent-command.js";

/** A kernel whose registry just records what is added. */
async function boot(): Promise<{ kernel: ReturnType<typeof createKernel>; added: AgentSpec[] }> {
  const added: AgentSpec[] = [];
  const registry = definePlugin({
    id: "acp",
    version: "0.1.0",
    setup(ctx) {
      ctx.provide(AgentRegistryRef, {
        add: (spec) => {
          added.push(spec);
          return () => undefined;
        },
        list: () => added,
      });
    },
  });
  const kernel = createKernel({ config: {} });
  await kernel.reconcile([registry]);
  return { kernel, added };
}

describe("overrideAgent", () => {
  it("does nothing without a command", async () => {
    const { kernel, added } = await boot();
    overrideAgent(kernel, undefined);
    overrideAgent(kernel, "   ");
    expect(added).toEqual([]);
    await kernel.dispose();
  });

  it("registers claude-code running node as the app's own binary", async () => {
    const { kernel, added } = await boot();
    overrideAgent(kernel, "node /abs/agent.mjs --flag");
    expect(added).toEqual([
      {
        id: "claude-code",
        title: "Claude Code",
        command: process.execPath,
        args: ["/abs/agent.mjs", "--flag"],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      },
    ]);
    await kernel.dispose();
  });

  it("runs any other binary as is", async () => {
    const { kernel, added } = await boot();
    overrideAgent(kernel, "python agent.py");
    expect(added).toEqual([
      { id: "claude-code", title: "Claude Code", command: "python", args: ["agent.py"] },
    ]);
    await kernel.dispose();
  });
});
