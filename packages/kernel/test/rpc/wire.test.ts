import { describe, expect, it } from "vitest";

import { createHook } from "../../src/core/definitions.js";
import type { Kernel } from "../../src/core/kernel.js";
import { createKernel } from "../../src/core/kernel.js";
import { createRpcEndpoint } from "../../src/rpc/endpoint.js";
import { createMemoryTransportPair } from "../../src/rpc/memory-transport.js";
import { startTimer } from "../../src/rpc/platform.js";
import type { RpcMessage } from "../../src/rpc/protocol.js";
import { exposeHooks } from "../../src/rpc/remote-hooks.js";
import { tapRemote } from "../../src/rpc/remote-taps.js";
import { rejection } from "../core/kernel-helpers.js";

const H = createHook<{ n: number }, Promise<number>>("h.wire");
const tick = (): Promise<void> => new Promise((r) => startTimer(r, 0));

describe("rpc wire protocol", () => {
  it("tapping side passes unknown taps through and ignores stray tap-results", async () => {
    const [raw, tb] = createMemoryTransportPair();
    const seen: RpcMessage[] = [];
    raw.onMessage((incoming) => {
      const msg = incoming as RpcMessage;
      seen.push(msg);
      if (msg.type === "call") raw.send({ type: "result", id: msg.id, value: undefined });
    });
    const win = createKernel();
    const eb = createRpcEndpoint(tb);
    await win.reconcile([
      {
        id: "t",
        version: "1.0.0",
        setup: (ctx) => {
          tapRemote(ctx, H, { endpoint: eb, handler: (c, next) => next(c) });
        },
      },
    ]);
    await tick();
    seen.length = 0;
    raw.send({ type: "tap-result", id: 1, for: "tap", outcome: { ok: true, value: 0 } });
    raw.send({ type: "tap-result", id: 2, for: "next", outcome: { ok: true, value: 0 } });
    raw.send({ type: "tap-invoke", id: 100, tapId: 999, ctx: { n: 1 } });
    await tick();
    expect(seen).toEqual([{ type: "tap-next", id: 100, ctx: { n: 1 } }]);
    raw.send({ type: "tap-result", id: 100, for: "next", outcome: { ok: true, value: 7 } });
    await tick();
    expect(seen[1]).toEqual({ type: "tap-result", id: 100, for: "tap", outcome: { ok: true, value: 7 } });
  });

  it("exposing side ignores tap-results meant for next() and stray ids", async () => {
    const [ta, raw] = createMemoryTransportPair();
    const main = createKernel();
    await main.reconcile([]);
    exposeHooks(main, createRpcEndpoint(ta), [H]);
    const seen: RpcMessage[] = [];
    raw.onMessage((msg) => seen.push(msg as RpcMessage));
    raw.send({ type: "call", id: 1, target: "loom:hook:h.wire", method: "tap", args: [{ tapId: 5, owner: "w", timeoutMs: 1000 }] });
    await tick();
    const run = main.run(H, { n: 1 }, (c) => Promise.resolve(c.n));
    await tick();
    const invoke = seen.find((m) => m.type === "tap-invoke");
    expect(invoke).toMatchObject({ tapId: 5, ctx: { n: 1 } });
    const id = invoke?.id ?? -1;
    raw.send({ type: "tap-result", id, for: "next", outcome: { ok: true, value: 0 } });
    raw.send({ type: "tap-result", id: 9999, for: "tap", outcome: { ok: true, value: 0 } });
    raw.send({ type: "tap-result", id, for: "tap", outcome: { ok: true, value: 42 } });
    await expect(run).resolves.toBe(42);
  });

  it("memory transport drops messages sent after or in flight at close", async () => {
    const [ta, tb] = createMemoryTransportPair();
    const got: RpcMessage[] = [];
    tb.onMessage((m) => got.push(m as RpcMessage));
    const off = tb.onClose(() => undefined);
    off();
    ta.send({ type: "cancel", id: 1 });
    ta.close();
    ta.send({ type: "cancel", id: 2 });
    await tick();
    expect(got).toEqual([]);
  });

  it("non-Error rejections travel as RPC_REMOTE_ERROR with their string form", async () => {
    const [ta, tb] = createMemoryTransportPair();
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- exercising non-Error values
    createRpcEndpoint(tb).handle("t", () => Promise.reject("just a string"));
    const err = await rejection(createRpcEndpoint(ta).call("t", "m", []));
    expect([err.code, err.message]).toEqual(["RPC_REMOTE_ERROR", "just a string"]);
  });

  it("exposeHooks rejects a kernel not created by createKernel", () => {
    const [ta] = createMemoryTransportPair();
    expect(() => exposeHooks({} as Kernel, createRpcEndpoint(ta), [H])).toThrow(TypeError);
  });
});
