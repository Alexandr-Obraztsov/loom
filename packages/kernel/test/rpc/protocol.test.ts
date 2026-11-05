import { describe, expect, it } from "vitest";

import { createHook, createServiceRef } from "../../src/core/definitions.js";
import type { LoomError } from "../../src/core/errors.js";
import { createKernel } from "../../src/core/kernel.js";
import type { RpcEndpointOptions } from "../../src/rpc/endpoint.js";
import { channelOf, createRpcEndpoint } from "../../src/rpc/endpoint.js";
import { createMemoryTransportPair } from "../../src/rpc/memory-transport.js";
import type { RpcMessage, Transport } from "../../src/rpc/protocol.js";
import { exposeHooks } from "../../src/rpc/remote-hooks.js";
import { exposeServices, remoteServicesPlugin } from "../../src/rpc/remote-services.js";
import { collectingUncaught } from "./uncaught.js";

const H = createHook<{ n: number }, Promise<number>>("h.proto");

/** A transport whose incoming side is driven by `deliver`, called synchronously like a real listener. */
function rawTransport(send: (m: RpcMessage) => void = () => undefined): { transport: Transport; deliver: (m: unknown) => void } {
  let listener: ((m: RpcMessage) => void) | undefined;
  return {
    transport: { send, onMessage: (cb) => ((listener = cb), () => undefined), onClose: () => () => undefined },
    deliver: (m) => {
      listener?.(m as RpcMessage);
    },
  };
}

function reporting(options: Partial<RpcEndpointOptions> = {}): { deliver: (m: unknown) => void; reports: LoomError[] } {
  const reports: LoomError[] = [];
  const { transport, deliver } = rawTransport();
  createRpcEndpoint(transport, { onProtocolError: (e) => reports.push(e), ...options });
  return { deliver, reports };
}

const malformed: [string, unknown][] = [
  ["null", null],
  ["a string", "call"],
  ["no type", { id: 1 }],
  ["unknown type", { type: "nope", id: 1 }],
  ["call without args", { type: "call", id: 1, target: "t", method: "m" }],
  ["call with a string id", { type: "call", id: "1", target: "t", method: "m", args: [] }],
  ["result without id", { type: "result", value: 1 }],
  ["error without error", { type: "error", id: 1 }],
  ["error with non-string pluginIds", { type: "error", id: 1, error: { code: "X", message: "m", pluginIds: [1] } }],
  ["cancel with a fractional id", { type: "cancel", id: 1.5 }],
  ["tap-invoke without tapId", { type: "tap-invoke", id: 1, ctx: {} }],
  ["tap-next without id", { type: "tap-next", ctx: {} }],
  ["tap-result without outcome", { type: "tap-result", id: 1, for: "tap" }],
  ["tap-result with a bad phase", { type: "tap-result", id: 1, for: "x", outcome: { ok: true, value: 1 } }],
  ["tap-result failure without error", { type: "tap-result", id: 1, for: "next", outcome: { ok: false } }],
];

describe("rpc protocol validation (malformed messages)", () => {
  it.each(malformed)("drops %s without throwing and reports it once", (_name, message) => {
    const { deliver, reports } = reporting();
    expect(() => {
      deliver(message);
    }).not.toThrow();
    expect(reports.map((e) => [e.code, e.details])).toEqual([["RPC_REMOTE_ERROR", { message }]]);
  });

  it("a handling failure (transport send throws) is reported, not thrown; failing sinks are contained", () => {
    const reports: LoomError[] = [];
    const { transport, deliver } = rawTransport(() => {
      throw new Error("wire down");
    });
    const endpoint = createRpcEndpoint(transport, {
      onProtocolError: (e) => {
        reports.push(e);
        throw new Error("sink down");
      },
    });
    channelOf(endpoint).onProtocolError({}, () => {
      throw new Error("sink down too");
    });
    expect(() => {
      deliver({ type: "call", id: 1, target: "none", method: "m", args: [] });
    }).not.toThrow();
    expect(reports.map((e) => e.message)).toEqual([expect.stringContaining("wire down")]);
  });

  it("exposeHooks, exposeServices and remoteServicesPlugin route protocol errors to kernel.error once per kernel", async () => {
    const [ta, tb] = createMemoryTransportPair();
    const ea = createRpcEndpoint(ta);
    const eb = createRpcEndpoint(tb);
    const main = createKernel();
    const win = createKernel();
    const mainErrors: LoomError[] = [];
    const winErrors: LoomError[] = [];
    main.on<LoomError>("kernel.error", (e) => mainErrors.push(e));
    win.on<LoomError>("kernel.error", (e) => winErrors.push(e));
    const stopHooks = exposeHooks(main, ea, [H]);
    const stopServices = exposeServices(main, ea, [createServiceRef<object>("svc.p")]);
    await win.reconcile([remoteServicesPlugin({ id: "remote", endpoint: eb, refs: [] })]);
    tb.send({ type: "error", id: 1 } as unknown as RpcMessage);
    ta.send(null as unknown as RpcMessage);
    await Promise.resolve();
    await Promise.resolve();
    expect([mainErrors.length, winErrors.length]).toEqual([1, 1]);
    stopHooks();
    tb.send({ type: "cancel" } as unknown as RpcMessage);
    await Promise.resolve();
    expect(mainErrors.length).toBe(2);
    stopServices();
    await win.reconcile([]);
    // no sink left on either side: the endpoints surface the problem as an uncaught error instead
    const uncaught = await collectingUncaught(async () => {
      tb.send({ type: "cancel" } as unknown as RpcMessage);
      ta.send({ type: "cancel" } as unknown as RpcMessage);
      await Promise.resolve();
    });
    expect([mainErrors.length, winErrors.length]).toEqual([2, 1]);
    expect(uncaught).toHaveLength(2);
  });

  it("exposeServices alone routes protocol errors to kernel.error", async () => {
    const { transport, deliver } = rawTransport();
    const main = createKernel();
    const errors: LoomError[] = [];
    main.on<LoomError>("kernel.error", (e) => errors.push(e));
    exposeServices(main, createRpcEndpoint(transport), []);
    deliver({ type: "bye", extra: true });
    deliver(42);
    await Promise.resolve();
    expect(errors.map((e) => e.code)).toEqual(["RPC_REMOTE_ERROR"]);
  });
});
