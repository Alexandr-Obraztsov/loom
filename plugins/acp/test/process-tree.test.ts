import { describe, expect, it, vi } from "vitest";

import type { AgentSpec } from "../src/api.js";
import { KILL_GRACE_MS, spawnAgent } from "../src/main/process.js";

const node = (script: string): AgentSpec => ({
  id: "n",
  title: "N",
  command: process.execPath,
  args: ["-e", script],
});

describe("spawnAgent process tree", () => {
  it("kill takes the whole tree even when a grandchild holds the pipes", async () => {
    const grandchild = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)`;
    const p = spawnAgent(
      node(
        `const c = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: ["ignore", "inherit", "inherit"] });` +
          `process.stderr.write("gc:" + c.pid + "\\n"); setInterval(() => {}, 1000)`,
      ),
      process.cwd(),
    );
    await vi.waitFor(() => {
      expect(p.stderrTail()).toMatch(/gc:\d+/);
    });
    const gc = Number(/gc:(\d+)/.exec(p.stderrTail())?.[1]);
    const started = Date.now();
    await p.kill();
    expect(Date.now() - started).toBeLessThan(KILL_GRACE_MS);
    await vi.waitFor(() => {
      expect(() => process.kill(gc, 0)).toThrow(/ESRCH/);
    });
  });
});
