import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createKernel, createServiceRef, definePlugin } from "@loom/kernel";
import type { Kernel } from "@loom/kernel";
import { AgentRegistryRef, PromptHook, SessionsRef, ToolCallHook } from "../src/api.js";
import type { AgentSpec, Sessions } from "../src/api.js";
import acp from "../src/main.js";
import { itemsOf, only } from "./helpers.js";

const STUB = fileURLToPath(new URL("./fixtures/stub-agent.mjs", import.meta.url));
const stub: AgentSpec = { id: "stub", title: "Stub", command: process.execPath, args: [STUB] };
const broken: AgentSpec = {
  id: "broken",
  title: "Broken",
  command: process.execPath,
  args: ["-e", `process.stderr.write("not logged in\\n", () => process.exit(1))`],
};

const kernels: Kernel[] = [];
afterEach(async () => {
  await Promise.all(kernels.splice(0).map((k) => k.dispose()));
});

async function boot(
  decide?: () => Promise<{ optionId: string } | null | undefined>,
): Promise<Sessions> {
  const Out = createServiceRef<{ sessions: Sessions }>("test.out");
  const user = definePlugin({
    id: "user",
    version: "1.0.0",
    dependsOn: { acp: "*" },
    setup(ctx) {
      ctx.use(AgentRegistryRef).add(stub);
      ctx.use(AgentRegistryRef).add(broken);
      if (decide) ctx.tap(ToolCallHook, {}, decide);
      ctx.tap(PromptHook, {}, async (c, next) => next({ ...c, text: c.text.toUpperCase() }));
      ctx.provide(Out, { sessions: ctx.use(SessionsRef) });
    },
  });
  const kernel = createKernel({ config: {} });
  kernels.push(kernel);
  await kernel.reconcile([acp, user]);
  return kernel.services.use(Out).sessions;
}

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
