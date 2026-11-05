import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Kernel } from "@loom/kernel";
import {
  createKernel,
  createMemoryTransportPair,
  createRpcEndpoint,
  createServiceRef,
  exposeServices,
} from "@loom/kernel";
import { definePlugin,HostRef } from "@loom/sdk";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentRegistry, AgentSpec, Sessions } from "../src/api.js";
import { AgentRegistryRef, SessionsRef } from "../src/api.js";
import acp from "../src/main.js";
import acpRenderer from "../src/renderer.js";
import { itemsOf } from "./helpers.js";

const STUB = fileURLToPath(new URL("./fixtures/stub-agent.mjs", import.meta.url));
const stub: AgentSpec = { id: "stub", title: "Stub", command: process.execPath, args: [STUB] };

const Out = createServiceRef<{ sessions: Sessions; agents: AgentRegistry }>(
  "test.renderer.out",
);

const kernels: Kernel[] = [];
afterEach(async () => {
  await Promise.all(kernels.splice(0).map((k) => k.dispose()));
});

describe("acp renderer entry", () => {
  it("renderer acp proxies Sessions over a memory transport", async () => {
    const [mainTransport, rendererTransport] = createMemoryTransportPair();

    const main = createKernel({ config: {} });
    kernels.push(main);
    const registrar = definePlugin({
      id: "registrar",
      version: "1.0.0",
      dependsOn: { acp: "^0.1.0" },
      setup(ctx) {
        ctx.use(AgentRegistryRef).add(stub);
      },
    });
    await main.reconcile([acp, registrar]);
    const stopExposure = exposeServices(main, createRpcEndpoint(mainTransport), [
      SessionsRef,
      AgentRegistryRef,
    ]);

    const renderer = createKernel({
      hostServices: [
        [
          HostRef,
          {
            process: "renderer",
            projectDir: mkdtempSync(join(tmpdir(), "acp-renderer-")),
            dataDir: "",
            endpoint: createRpcEndpoint(rendererTransport),
          },
        ],
      ],
    });
    kernels.push(renderer);
    const consumer = definePlugin({
      id: "consumer",
      version: "1.0.0",
      dependsOn: { acp: "^0.1.0" },
      setup(ctx) {
        ctx.provide(Out, { sessions: ctx.use(SessionsRef), agents: ctx.use(AgentRegistryRef) });
      },
    });
    await renderer.reconcile([acpRenderer, consumer]);

    const out = renderer.services.use(Out);
    // over rpc every method is async, `list` included: the proxy's promise resolves to the specs
    const agents = await (out.agents.list() as unknown as Promise<readonly AgentSpec[]>);
    expect(agents.map((a) => a.id)).toEqual(["stub"]);

    // AcpError crosses the rpc as a remote error; only the message survives (not the code).
    await expect(out.sessions.ensure({ agentId: "ghost", cwd: process.cwd() })).rejects.toThrow(
      /ghost/,
    );

    const { sessionId } = await out.sessions.ensure({ agentId: "stub", cwd: process.cwd() });
    await out.sessions.prompt(sessionId, "hi");
    await expect
      .poll(
        async () =>
          itemsOf((await out.sessions.waitUpdates(sessionId, -1, 1)).items, "agent").at(0)?.text,
      )
      .toBe("echo:hi");
    stopExposure();
  });
});
