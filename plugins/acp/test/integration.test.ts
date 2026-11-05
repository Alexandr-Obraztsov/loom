import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { Sessions } from "../src/api.js";
import { boot, kernels, pidFile } from "./boot.js";
import { itemsOf, only } from "./helpers.js";

const text = async (s: Sessions, id: string) =>
  itemsOf((await s.waitUpdates(id, -1, 1)).items, "agent");

describe("acp plugin with real agent processes", () => {
  it("fails to start with stderr in the message", async () => {
    const s = await boot();
    await expect(s.ensure({ agentId: "broken", cwd: process.cwd() })).rejects.toThrow(
      /код 1[\s\S]*not logged in/,
    );
    await expect(s.ensure({ agentId: "ghost", cwd: process.cwd() })).rejects.toMatchObject({
      code: "AGENT_UNKNOWN",
    });
  });

  it("runs a prompt through PromptHook", async () => {
    const s = await boot();
    const { sessionId } = await s.ensure({ agentId: "stub", cwd: process.cwd() });
    await s.prompt(sessionId, "hi");
    await expect.poll(async () => (await text(s, sessionId)).at(0)?.text).toBe("echo:HI");
  });

  it("ToolCallHook allow skips the user", async () => {
    const s = await boot(() => Promise.resolve({ optionId: "allow" }));
    const { sessionId } = await s.ensure({ agentId: "stub", cwd: process.cwd() });
    await s.prompt(sessionId, "permission");
    await expect.poll(async () => (await text(s, sessionId)).at(0)?.text).toBe("perm:allow");
  });

  it("undecided permission is answered through the service; cancel and close work", async () => {
    const s = await boot();
    const { sessionId } = await s.ensure({ agentId: "stub", cwd: process.cwd() });
    const turn = s.prompt(sessionId, "permission");
    let id = "";
    await expect
      .poll(async () => {
        id = itemsOf((await s.waitUpdates(sessionId, -1, 1)).items, "permission").at(0)?.id ?? "";
        return id;
      })
      .not.toBe("");
    await s.respondPermission(sessionId, id, "reject");
    await turn;
    await expect.poll(async () => (await text(s, sessionId)).at(0)?.text).toBe("perm:reject");
    await s.cancel(sessionId);
    await s.close(sessionId);
    await expect(s.cancel(sessionId)).rejects.toMatchObject({ code: "SESSION_UNKNOWN" });
  });

  it("agent that exits shows an error item with stderr and the next prompt restarts it", async () => {
    const s = await boot(() => Promise.resolve({ optionId: "allow" }));
    const { sessionId } = await s.ensure({ agentId: "stub", cwd: process.cwd() });
    await expect(s.prompt(sessionId, "crash")).rejects.toMatchObject({ code: "AGENT_EXITED" });
    await expect
      .poll(async () => itemsOf((await s.waitUpdates(sessionId, -1, 1)).items, "error").length)
      .toBe(1);
    const snap = await s.waitUpdates(sessionId, -1, 1);
    expect(only(itemsOf(snap.items, "error")).stderr).toBe("boom\n");
    expect(snap.busy).toBe(false);

    await s.prompt(sessionId, "again");
    await expect.poll(async () => (await text(s, sessionId)).at(-1)?.text).toBe("echo:AGAIN");
  });
});

describe("acp plugin shutdown with real agent processes", () => {
  it("dispose while the handshake never completes kills the agent process", async () => {
    const s = await boot();
    const starting = s.ensure({ agentId: "silent", cwd: process.cwd() });
    const rejected = expect(starting).rejects.toMatchObject({ code: "AGENT_START_FAILED" });
    let pid = 0;
    await expect
      .poll(() => {
        try {
          pid = Number(readFileSync(pidFile, "utf8"));
        } catch {
          pid = 0;
        }
        return pid;
      })
      .toBeGreaterThan(0);
    await kernels.pop()?.dispose();
    await rejected;
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  });

  it("dispose kills agent processes", async () => {
    const s = await boot();
    const { sessionId } = await s.ensure({ agentId: "stub", cwd: process.cwd() });
    await s.prompt(sessionId, "pid");
    let pid = 0;
    await expect
      .poll(async () => {
        const t = (await text(s, sessionId)).at(0)?.text ?? "";
        pid = Number(t.replace("pid:", ""));
        return pid > 0;
      })
      .toBe(true);
    await kernels.pop()?.dispose();
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  });
});
