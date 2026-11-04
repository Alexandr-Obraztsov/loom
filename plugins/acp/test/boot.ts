import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import { createKernel, createServiceRef, definePlugin } from "@loom/kernel";
import type { Kernel } from "@loom/kernel";
import { AgentRegistryRef, PromptHook, SessionsRef, ToolCallHook } from "../src/api.js";
import type { AgentSpec, Sessions } from "../src/api.js";
import acp from "../src/main.js";

const STUB = fileURLToPath(new URL("./fixtures/stub-agent.mjs", import.meta.url));
const stub: AgentSpec = { id: "stub", title: "Stub", command: process.execPath, args: [STUB] };
const broken: AgentSpec = {
  id: "broken",
  title: "Broken",
  command: process.execPath,
  args: ["-e", `process.stderr.write("not logged in\\n", () => process.exit(1))`],
};

export const pidFile: string = join(mkdtempSync(join(tmpdir(), "acp-")), "pid");
const silent: AgentSpec = {
  id: "silent",
  title: "Silent",
  command: process.execPath,
  args: [
    "-e",
    `require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)`,
    pidFile,
  ],
};

export const kernels: Kernel[] = [];
afterEach(async () => {
  await Promise.all(kernels.splice(0).map((k) => k.dispose()));
});

export async function boot(
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
      ctx.use(AgentRegistryRef).add(silent);
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
