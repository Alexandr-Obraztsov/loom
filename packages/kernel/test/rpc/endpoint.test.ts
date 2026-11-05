import { describe, expect, it } from "vitest";

import { LoomError } from "../../src/core/errors.js";
import type { RpcEndpoint } from "../../src/rpc/endpoint.js";
import { channelOf, createRpcEndpoint } from "../../src/rpc/endpoint.js";
import type { MemoryTransport } from "../../src/rpc/memory-transport.js";
import { createMemoryTransportPair } from "../../src/rpc/memory-transport.js";
import type { AbortSignalLike } from "../../src/rpc/platform.js";
import { createAbortController, microtask, startTimer } from "../../src/rpc/platform.js";
import type { RpcMessage, Transport } from "../../src/rpc/protocol.js";
import { rejection } from "../core/kernel-helpers.js";

const tick = (): Promise<void> => new Promise((r) => startTimer(r, 0));

function connect(): { a: RpcEndpoint; b: RpcEndpoint; ta: MemoryTransport; tb: MemoryTransport } {
  const [ta, tb] = createMemoryTransportPair();
  return { a: createRpcEndpoint(ta), b: createRpcEndpoint(tb), ta, tb };
}

describe("rpc endpoint", () => {
  it("remote service method call returns value", async () => {
    const { a, b } = connect();
    b.handle("math", (method, args) => Promise.resolve({ method, sum: (args as number[]).reduce((x, y) => x + y, 0) }));
    await expect(a.call("math", "add", [1, 2, 3])).resolves.toEqual({ method: "add", sum: 6 });
  });

  it("remote LoomError arrives with same code and pluginIds (cloneable details kept)", async () => {
    const { a, b } = connect();
    b.handle("svc", () => Promise.reject(new LoomError("SERVICE_MISSING", "gone", { pluginIds: ["p", "q"], details: { ref: "x" } })));
    const err = await rejection(a.call("svc", "m", []));
    expect(err).toBeInstanceOf(LoomError);
    expect({ code: err.code, message: err.message, pluginIds: err.pluginIds, details: err.details }).toEqual({
      code: "SERVICE_MISSING",
      message: "gone",
      pluginIds: ["p", "q"],
      details: { ref: "x" },
    });
  });

  it("drops non-cloneable details and maps plain errors to RPC_REMOTE_ERROR", async () => {
    const { a, b } = connect();
    b.handle("x", (method) =>
      Promise.reject(method === "loom" ? new LoomError("TAP_FAILED", "t", { details: { fn: () => 1 } }) : new Error("plain")),
    );
    const loom = await rejection(a.call("x", "loom", []));
    expect([loom.code, loom.details]).toEqual(["TAP_FAILED", undefined]);
    const plain = await rejection(a.call("x", "other", []));
    expect([plain.code, plain.message, plain.pluginIds]).toEqual(["RPC_REMOTE_ERROR", "plain", []]);
  });

});

describe("rpc endpoint cancellation and close", () => {
  it("AbortSignal abort sends cancel and rejects with RPC_CANCELLED; handler sees aborted signal", async () => {
    const { a, b, ta } = connect();
    const sent: RpcMessage[] = [];
    const send = ta.send.bind(ta);
    ta.send = (msg) => {
      sent.push(msg);
      send(msg);
    };
    let seen: AbortSignalLike | undefined;
    let finish: (v: unknown) => void = () => undefined;
    b.handle("slow", (_m, _a, signal) => {
      seen = signal;
      return new Promise((r) => (finish = r));
    });
    const controller = createAbortController();
    const call = a.call("slow", "run", [], controller.signal);
    await tick();
    expect(seen?.aborted).toBe(false);
    controller.abort();
    expect((await rejection(call)).code).toBe("RPC_CANCELLED");
    expect(sent.map((m) => m.type)).toEqual(["call", "cancel"]);
    await tick();
    expect(seen?.aborted).toBe(true);
    finish("late");
    await tick();
  });

  it("an already aborted signal rejects without sending; a late result after cancel is ignored", async () => {
    const { a, ta } = connect();
    const sent: string[] = [];
    const send = ta.send.bind(ta);
    ta.send = (msg) => {
      sent.push(msg.type);
      send(msg);
    };
    const controller = createAbortController();
    controller.abort();
    expect((await rejection(a.call("t", "m", [], controller.signal))).code).toBe("RPC_CANCELLED");
    expect(sent).toEqual([]);
    // the peer ignores cancel and answers anyway: the answer must not resurrect the call
    const [tc, td] = createMemoryTransportPair();
    const c = createRpcEndpoint(tc);
    td.onMessage((raw) => {
      const msg = raw as RpcMessage;
      if (msg.type !== "call") return;
      microtask(() => {
        td.send({ type: "result", id: msg.id, value: "late" });
      });
    });
    const late = createAbortController();
    const call = c.call("t", "m", [], late.signal);
    late.abort();
    expect((await rejection(call)).code).toBe("RPC_CANCELLED");
    await tick();
  });

});

describe("rpc endpoint close", () => {
  it("transport close rejects pending calls with RPC_DISCONNECTED", async () => {
    const { a, b, tb } = connect();
    let signal: AbortSignalLike | undefined;
    b.handle("hang", (_m, _a, s) => {
      signal = s;
      return new Promise(() => undefined);
    });
    const call = a.call("hang", "m", []);
    await tick();
    tb.close();
    expect((await rejection(call)).code).toBe("RPC_DISCONNECTED");
    expect(signal?.aborted).toBe(true);
    expect((await rejection(a.call("hang", "m", []))).code).toBe("RPC_DISCONNECTED");
    expect(channelOf(a).isClosed).toBe(true);
  });

  it("endpoint.close answers in-flight incoming calls with RPC_DISCONNECTED and rejects its own", async () => {
    const { a, b } = connect();
    let signal: AbortSignalLike | undefined;
    b.handle("hang", (_m, _a, s) => {
      signal = s;
      return new Promise(() => undefined);
    });
    a.handle("hang", () => new Promise(() => undefined));
    const incoming = a.call("hang", "m", []);
    const outgoing = b.call("hang", "m", []);
    await tick();
    b.close();
    b.close();
    expect(signal?.aborted).toBe(true);
    expect((await rejection(incoming)).code).toBe("RPC_DISCONNECTED");
    expect((await rejection(outgoing)).code).toBe("RPC_DISCONNECTED");
  });

});

describe("rpc endpoint edge cases", () => {
  it("non-cloneable argument rejects with RPC_REMOTE_ERROR instead of throwing synchronously", async () => {
    const { a, b } = connect();
    b.handle("t", () => Promise.resolve(() => "not cloneable"));
    let promise: Promise<unknown> | undefined;
    expect(() => (promise = a.call("t", "m", [() => 1]))).not.toThrow();
    expect((await rejection(promise as Promise<unknown>)).code).toBe("RPC_REMOTE_ERROR");
    const result = await rejection(a.call("t", "m", []));
    expect([result.code, result.message]).toEqual(["RPC_REMOTE_ERROR", expect.stringContaining("Cannot send result")]);
  });

  it("unknown target rejects with RPC_REMOTE_ERROR; a second handler throws SERVICE_CONFLICT", async () => {
    const { a, b } = connect();
    expect((await rejection(a.call("nobody", "m", []))).code).toBe("RPC_REMOTE_ERROR");
    const remove = b.handle("t", () => Promise.resolve(1));
    let conflict: unknown;
    try {
      b.handle("t", () => Promise.resolve(2));
    } catch (e) {
      conflict = e;
    }
    expect((conflict as LoomError).code).toBe("SERVICE_CONFLICT");
    remove();
    remove();
    b.handle("t", () => Promise.resolve(3));
    await expect(a.call("t", "m", [])).resolves.toBe(3);
  });

  it("channelOf rejects foreign endpoints; onClose after close runs immediately", () => {
    const fake: RpcEndpoint = { call: () => Promise.resolve(), handle: () => () => undefined, close: () => undefined };
    expect(() => channelOf(fake)).toThrow(LoomError);
    const { a, ta } = connect();
    ta.close();
    ta.close();
    let ran = 0;
    channelOf(a).onClose(() => ran++)();
    expect(ran).toBe(1);
    expect(() => {
      channelOf(a).send({ type: "cancel", id: 1 });
    }).not.toThrow();
  });

  it("works over a custom transport and ignores messages after close", async () => {
    const listeners: ((m: RpcMessage) => void)[] = [];
    const closers: (() => void)[] = [];
    const transport: Transport = {
      send: () => undefined,
      onMessage: (cb) => (listeners.push(cb), () => undefined),
      onClose: (cb) => (closers.push(cb), () => undefined),
    };
    const e = createRpcEndpoint(transport);
    const call = e.call("t", "m", []);
    listeners[0]?.({ type: "result", id: 99, value: "stray" });
    listeners[0]?.({ type: "result", id: 1, value: "ok" });
    await expect(call).resolves.toBe("ok");
    e.close();
    expect(() => listeners[0]?.({ type: "call", id: 2, target: "t", method: "m", args: [] })).not.toThrow();
    expect(() => closers[0]?.()).not.toThrow();
  });
});

describe("rpc endpoint reply failures", () => {
  it("a reply that cannot be sent is reported once, shuts the endpoint down and rejects nothing unhandled", async () => {
    const [ta, tb] = createMemoryTransportPair();
    const reports: LoomError[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => {
      unhandled.push(e);
    };
    process.on("unhandledRejection", onUnhandled);
    const a = createRpcEndpoint(ta);
    const b = createRpcEndpoint(tb, { onProtocolError: (e) => reports.push(e) });
    let release: () => void = () => undefined;
    b.handle(
      "t",
      () =>
        new Promise<number>((r) => {
          release = () => {
            r(1);
          };
        }),
    );
    const call = a.call("t", "m", []);
    call.catch(() => undefined);
    await tick();
    tb.send = () => {
      throw new Error("transport dead");
    };
    release();
    await tick();
    await tick();
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
    expect(reports.map((e) => e.code)).toEqual(["RPC_REMOTE_ERROR"]);
    expect(channelOf(b).isClosed).toBe(true);
  });
});
