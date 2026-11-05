import { afterEach, describe, expect, it, vi } from "vitest";
import { createHook, createServiceRef } from "../../src/core/definitions.js";
import type { LoomError } from "../../src/core/errors.js";
import { createKernel } from "../../src/core/kernel.js";
import { channelOf, createRpcEndpoint } from "../../src/rpc/endpoint.js";
import { createMemoryTransportPair } from "../../src/rpc/memory-transport.js";
import { startTimer } from "../../src/rpc/platform.js";
import type { RpcMessage, Transport } from "../../src/rpc/protocol.js";
import { hookTarget } from "../../src/rpc/protocol.js";
import { exposeHooks, settleOutcome } from "../../src/rpc/remote-hooks.js";
import { exposeServices, remoteServicesPlugin } from "../../src/rpc/remote-services.js";
import { tapRemote } from "../../src/rpc/remote-taps.js";
import { rejection } from "../core/kernel-helpers.js";

const H = createHook<{ n: number }, Promise<number>>("h.cleanup");
const Svc = createServiceRef<{ slow(): number }>("svc.slow");
const sleep = (ms: number): Promise<void> => new Promise((r) => startTimer(r, ms));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("duplicate tapId from a peer", () => {
  it("replaces the previous tap, so the hook invokes the peer once", async () => {
    const [ta, tb] = createMemoryTransportPair();
    const ea = createRpcEndpoint(ta);
    const eb = createRpcEndpoint(tb);
    const main = createKernel();
    await main.reconcile([]);
    exposeHooks(main, ea, [H]);
    let invokes = 0;
    const peer = channelOf(eb);
    peer.onTapMessage((msg) => {
      if (msg.type === "tap-invoke") {
        invokes++;
        peer.send({ type: "tap-next", id: msg.id, ctx: msg.ctx });
      } else if (msg.type === "tap-result" && msg.for === "next" && msg.outcome.ok) {
        peer.send({ type: "tap-result", id: msg.id, for: "tap", outcome: msg.outcome });
      }
    });
    const request = { tapId: 7, owner: "dup", timeoutMs: 1000 };
    await eb.call(hookTarget(H.id), "tap", [request]);
    await eb.call(hookTarget(H.id), "tap", [request]);
    await expect(main.run(H, { n: 1 }, (c) => Promise.resolve(c.n * 10))).resolves.toBe(10);
    expect(invokes).toBe(1);
  });
});

describe("late tap-result after the timeout", () => {
  it("is ignored: only HOOK_TIMEOUT is reported and nothing throws", async () => {
    const [ta, tb] = createMemoryTransportPair();
    const ea = createRpcEndpoint(ta);
    const eb = createRpcEndpoint(tb);
    const main = createKernel();
    await main.reconcile([]);
    const errors: LoomError[] = [];
    main.on<LoomError>("kernel.error", (e) => errors.push(e));
    exposeHooks(main, ea, [H]);
    const win = createKernel();
    const winErrors: LoomError[] = [];
    win.on<LoomError>("kernel.error", (e) => winErrors.push(e));
    await win.reconcile([
      {
        id: "slow-tap",
        version: "1.0.0",
        setup(ctx) {
          tapRemote(ctx, eb, H, { timeoutMs: 20 }, async () => {
            await sleep(60);
            return 999;
          });
        },
      },
    ]);
    await sleep(0);
    await expect(main.run(H, { n: 2 }, (c) => Promise.resolve(c.n * 10))).resolves.toBe(20);
    await sleep(80);
    expect(errors.map((e) => e.code)).toEqual(["HOOK_TIMEOUT"]);
    expect(winErrors).toEqual([]);
  });
});

describe("endpoint without a protocol-error sink", () => {
  it("rethrows a malformed message in a microtask instead of dropping it silently", () => {
    let listener: (m: unknown) => void = () => undefined;
    const transport: Transport = { send: () => undefined, onMessage: (cb) => ((listener = cb), () => undefined), onClose: () => () => undefined };
    createRpcEndpoint(transport);
    const queued: (() => void)[] = [];
    vi.stubGlobal("queueMicrotask", (cb: () => void) => queued.push(cb));
    expect(() => {
      listener({ type: "nope" });
    }).not.toThrow();
    expect(queued).toHaveLength(1);
    expect(() => queued[0]?.()).toThrow(/Malformed RPC message/);
  });

  it("does not rethrow when a sink exists", () => {
    let listener: (m: unknown) => void = () => undefined;
    const transport: Transport = { send: () => undefined, onMessage: (cb) => ((listener = cb), () => undefined), onClose: () => () => undefined };
    createRpcEndpoint(transport, { onProtocolError: () => undefined });
    const queued: (() => void)[] = [];
    vi.stubGlobal("queueMicrotask", (cb: () => void) => queued.push(cb));
    listener(null);
    expect(queued).toHaveLength(0);
  });
});

describe("several sinks on one endpoint", () => {
  it("exposeServices and remoteServicesPlugin of the same kernel report a protocol error once", async () => {
    const [ta, tb] = createMemoryTransportPair();
    const ea = createRpcEndpoint(ta);
    const kernel = createKernel();
    const stop = exposeServices(kernel, ea, []);
    await kernel.reconcile([remoteServicesPlugin({ id: "remote", endpoint: ea, refs: [] })]);
    const errors: LoomError[] = [];
    kernel.on<LoomError>("kernel.error", (e) => errors.push(e));
    tb.send("garbage" as unknown as RpcMessage);
    await sleep(0);
    expect(errors).toHaveLength(1);
    stop();
    tb.send("garbage" as unknown as RpcMessage);
    await sleep(0);
    expect(errors).toHaveLength(2);
  });
});

describe("remoteServicesPlugin callTimeoutMs", () => {
  async function setup(callTimeoutMs?: number): Promise<{ proxy: { slow(): Promise<number> }; handlerSignal: () => boolean }> {
    const [ta, tb] = createMemoryTransportPair();
    const eb = createRpcEndpoint(tb);
    let aborted = false;
    eb.handle(Svc.id, (_m, _a, signal) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise<unknown>(() => undefined);
    });
    const ea = createRpcEndpoint(ta);
    const win = createKernel();
    await win.reconcile([remoteServicesPlugin({ id: "remote", endpoint: ea, refs: [Svc], ...(callTimeoutMs === undefined ? {} : { callTimeoutMs }) })]);
    return { proxy: win.services.use(Svc) as unknown as { slow(): Promise<number> }, handlerSignal: () => aborted };
  }

  it("rejects RPC_CANCELLED after the timeout and the peer receives cancel", async () => {
    const { proxy, handlerSignal } = await setup(50);
    const started = Date.now();
    const error = await rejection(proxy.slow());
    expect(error.code).toBe("RPC_CANCELLED");
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    await sleep(0);
    expect(handlerSignal()).toBe(true);
  });

  it("a call that finishes in time clears its timer", async () => {
    vi.useFakeTimers();
    const [ta, tb] = createMemoryTransportPair();
    createRpcEndpoint(tb).handle(Svc.id, () => Promise.resolve(5));
    const win = createKernel();
    await win.reconcile([remoteServicesPlugin({ id: "remote", endpoint: createRpcEndpoint(ta), refs: [Svc], callTimeoutMs: 50 })]);
    const proxy = win.services.use(Svc) as unknown as { slow(): Promise<number> };
    const result = proxy.slow();
    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toBe(5);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("without callTimeoutMs a call waits and is rejected RPC_DISCONNECTED when the endpoint closes", async () => {
    const [ta, tb] = createMemoryTransportPair();
    createRpcEndpoint(tb).handle(Svc.id, () => new Promise<unknown>(() => undefined));
    const ea = createRpcEndpoint(ta);
    const win = createKernel();
    await win.reconcile([remoteServicesPlugin({ id: "remote", endpoint: ea, refs: [Svc] })]);
    const proxy = win.services.use(Svc) as unknown as { slow(): Promise<number> };
    const pending = rejection(proxy.slow());
    await sleep(20);
    ea.close();
    expect((await pending).code).toBe("RPC_DISCONNECTED");
  });
});

describe("call abort handler", () => {
  it("a throwing transport.send for cancel causes no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const record = (e: unknown): void => void unhandled.push(e);
    process.on("unhandledRejection", record);
    try {
      let failing = false;
      const transport: Transport = {
        send: () => {
          if (failing) throw new Error("wire down");
        },
        onMessage: () => () => undefined,
        onClose: () => () => undefined,
      };
      const endpoint = createRpcEndpoint(transport);
      const controller = new AbortController();
      const call = rejection(endpoint.call("t", "m", [], controller.signal));
      failing = true;
      controller.abort();
      expect((await call).code).toBe("RPC_CANCELLED");
      await sleep(10);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });
});

describe("settleOutcome fallback", () => {
  it("an unsendable value becomes an RPC_REMOTE_ERROR outcome for the peer", async () => {
    const [ta, tb] = createMemoryTransportPair();
    const ea = createRpcEndpoint(ta);
    const peer = channelOf(createRpcEndpoint(tb));
    const seen: RpcMessage[] = [];
    peer.onTapMessage((m) => seen.push(m));
    settleOutcome(Promise.resolve(() => 1), channelOf(ea), 3, "tap");
    await sleep(0);
    expect(seen).toMatchObject([{ type: "tap-result", id: 3, for: "tap", outcome: { ok: false, error: { code: "RPC_REMOTE_ERROR" } } }]);
  });

  it("when even the fallback cannot be sent the failure is reported and the endpoint shuts down", async () => {
    const reports: LoomError[] = [];
    const transport: Transport = {
      send: () => {
        throw new Error("wire down");
      },
      onMessage: () => () => undefined,
      onClose: () => () => undefined,
    };
    const endpoint = createRpcEndpoint(transport, { onProtocolError: (e) => reports.push(e) });
    const channel = channelOf(endpoint);
    settleOutcome(Promise.resolve(1), channel, 1, "tap");
    await sleep(0);
    expect(reports.map((e) => e.message)).toEqual([expect.stringContaining("Cannot send RPC reply")]);
    expect(channel.closed).toBe(true);
  });
});
