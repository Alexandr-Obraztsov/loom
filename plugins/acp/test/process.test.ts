import { ClientApp } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  KILL_GRACE_MS,
  launchProcess,
  spawnAgent,
  STDERR_TAIL_BYTES,
} from "../src/main/process.js";

const node = (script: string) => ({
  id: "n",
  title: "N",
  command: process.execPath,
  args: ["-e", script],
});

afterEach(() => {
  vi.useRealTimers();
});

describe("spawnAgent", () => {
  it("reports exit code and the stderr tail", async () => {
    const p = spawnAgent(
      node(`process.stderr.write("oops\\n", () => process.exit(1))`),
      process.cwd(),
    );
    expect(await p.exited).toEqual({ code: 1, signal: null });
    expect(p.stderrTail()).toBe("oops\n");
    await p.kill();
  });

  it("keeps only the last 4 KB of stderr", async () => {
    const p = spawnAgent(
      node(`process.stderr.write("a".repeat(10000) + "END", () => process.exit(0))`),
      process.cwd(),
    );
    await p.exited;
    expect(p.stderrTail()).toHaveLength(STDERR_TAIL_BYTES);
    expect(p.stderrTail().endsWith("END")).toBe(true);
  });

  it("reports a spawn failure", async () => {
    const p = spawnAgent(
      { id: "x", title: "X", command: "/nonexistent/agent", args: [] },
      process.cwd(),
    );
    const info = await p.exited;
    expect(info.error).toContain("ENOENT");
    await p.kill(); // nothing to signal
  });

  it("passes env and cwd", async () => {
    const spec = {
      ...node(`process.stderr.write(process.env.ACP_T + process.cwd(), () => process.exit(0))`),
      env: { ACP_T: "v:" },
    };
    const p = spawnAgent(spec, "/");
    await p.exited;
    expect(p.stderrTail()).toBe("v:/");
  });

  it("kill sends SIGTERM and then SIGKILL to a process that ignores it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const p = spawnAgent(
      node(
        `process.on("SIGTERM", () => {}); process.stderr.write("ready"); setInterval(() => {}, 1000)`,
      ),
      process.cwd(),
    );
    await vi.waitFor(
      () => {
        expect(p.stderrTail()).toBe("ready");
      },
      { interval: 5 },
    );
    const killed = p.kill();
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
    await killed;
    expect(await p.exited).toMatchObject({ signal: "SIGKILL" });
    await p.kill(); // already gone
  });

  it("launchProcess wires the stream to the client app", async () => {
    const link = launchProcess(node(`setInterval(() => {}, 1000)`), process.cwd(), new ClientApp());
    expect(link.stderrTail()).toBe("");
    await link.kill();
    expect((await link.exited).signal).toBe("SIGTERM");
  });
});
