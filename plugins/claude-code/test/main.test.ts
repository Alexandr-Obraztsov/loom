import { existsSync } from "node:fs";
import { join } from "node:path";

import { createKernel } from "@loom/kernel";
import type { AgentSpec } from "@loom/plugin-acp";
import { AgentRegistryRef } from "@loom/plugin-acp";
import { definePlugin } from "@loom/sdk";
import { describe, expect, it } from "vitest";

import plugin from "../src/main.js";

describe("claude-code plugin", () => {
  it("claude-code registers its agent with resolved script path", async () => {
    const added: AgentSpec[] = [];
    const acp = definePlugin({
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
    const kernel = createKernel();
    await kernel.reconcile([acp, plugin]);

    expect(added).toHaveLength(1);
    const spec = added[0];
    if (!spec) throw new Error("agent spec missing");
    expect(spec.id).toBe("claude-code");
    expect(spec.title).toBe("Claude Code");
    expect(spec.command).toBe(process.execPath);
    expect(spec.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });

    expect(spec.args).toHaveLength(1);
    const [script] = spec.args;
    if (!script) throw new Error("script path missing");
    expect(script.endsWith(join("@agentclientprotocol", "claude-agent-acp", "dist", "index.js"))).toBe(
      true,
    );
    expect(existsSync(script)).toBe(true);
  });
});
