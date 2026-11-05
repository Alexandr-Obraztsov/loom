import { afterEach, describe, expect, it, vi } from "vitest";

import { createHook } from "../../src/core/definitions.js";
import { LoomError } from "../../src/core/errors.js";
import type { Kernel } from "../../src/core/kernel.js";
import { createKernel } from "../../src/core/kernel.js";
import type { HookRef, Next, PluginContext, PluginDefinition, TapOptions } from "../../src/core/types.js";
import type { RpcEndpoint } from "../../src/rpc/endpoint.js";
import { createRpcEndpoint } from "../../src/rpc/endpoint.js";
import type { MemoryTransport } from "../../src/rpc/memory-transport.js";
import { createMemoryTransportPair } from "../../src/rpc/memory-transport.js";
import { startTimer } from "../../src/rpc/platform.js";
import { exposeHooks } from "../../src/rpc/remote-hooks.js";
import { tapRemote } from "../../src/rpc/remote-taps.js";
import { rejection, thrown } from "../core/kernel-helpers.js";

interface Ctx {
  n: number;
  f?: () => void;
}
const H = createHook<Ctx, Promise<number>>("h.compute");
const SyncH = createHook<Ctx, number>("h.sync", { mode: "sync" });
const tick = (): Promise<void> => new Promise((r) => startTimer(r, 0));

type Fn = (c: Ctx, next: Next<Ctx, Promise<number>>) => Promise<number>;

function tapper(endpoint: RpcEndpoint, fn: Fn, opts: TapOptions<Ctx> & { timeoutMs?: number; id?: string } = {}): PluginDefinition {
  const { id = "win-tap", ...tapOptions } = opts;
  return {
    id,
    version: "1.0.0",
    setup(ctx) {
      tapRemote(ctx, H, { endpoint, ...tapOptions, handler: fn });
    },
  };
}

interface World {
  main: Kernel;
  win: Kernel;
  ea: RpcEndpoint;
  eb: RpcEndpoint;
  ta: MemoryTransport;
  errors: LoomError[];
  winErrors: LoomError[];
  stop: () => void;
  run: (n?: number, extra?: Partial<Ctx>) => Promise<number>;
}

async function world(): Promise<World> {
  const [ta, tb] = createMemoryTransportPair();
  const ea = createRpcEndpoint(ta);
  const eb = createRpcEndpoint(tb);
  const main = createKernel();
  await main.reconcile([]);
  const errors: LoomError[] = [];
  main.on<LoomError>("kernel.error", (e) => errors.push(e));
  const stop = exposeHooks(main, ea, [H]);
  const win = createKernel();
  const winErrors: LoomError[] = [];
  win.on<LoomError>("kernel.error", (e) => winErrors.push(e));
  const run = (n = 1, extra: Partial<Ctx> = {}): Promise<number> => main.run(H, { n, ...extra }, (c) => Promise.resolve(c.n * 10));
  return { main, win, ea, eb, ta, errors, winErrors, stop, run };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("remote hooks", () => {
  it("remote tap can modify ctx and result", async () => {
    const w = await world();
    await w.win.reconcile([tapper(w.eb, async (c, next) => (await next({ n: c.n + 1 })) + 5)]);
    await tick();
    await expect(w.run(1)).resolves.toBe(25);
  });

  it("hanging remote tap times out, run continues with next, kernel.error HOOK_TIMEOUT names owner", async () => {
    vi.useFakeTimers();
    const w = await world();
    await w.win.reconcile([tapper(w.eb, () => new Promise(() => undefined))]);
    await vi.advanceTimersByTimeAsync(0);
    const result = w.run(2);
    await vi.advanceTimersByTimeAsync(4999);
    expect(w.errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(20);
    expect(w.errors.map((e) => [e.code, e.pluginIds])).toEqual([["HOOK_TIMEOUT", ["remote:win-tap"]]]);
    expect(w.errors[0]?.message).toContain("remote:win-tap");
  });

  it("timeout after the remote called next keeps the downstream result and honours timeoutMs", async () => {
    vi.useFakeTimers();
    const w = await world();
    let calls = 0;
    const counting = { n: 0 };
    await w.win.reconcile([
      tapper(
        w.eb,
        async (c, next) => {
          calls++;
          await next({ n: c.n + 1 });
          return new Promise(() => undefined);
        },
        { timeoutMs: 100 },
      ),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    const result = w.main.run(H, { n: 1 }, (c) => {
      counting.n++;
      return Promise.resolve(c.n * 10);
    });
    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toBe(20);
    expect([calls, counting.n, w.errors[0]?.code]).toEqual([1, 1, "HOOK_TIMEOUT"]);
  });

});

describe("remote hook lifecycle", () => {
  it("remote tap on sync hook throws TAP_FAILED", async () => {
    const w = await world();
    let error: LoomError | undefined;
    await w.win.reconcile([
      {
        id: "sync-tap",
        version: "1.0.0",
        setup(ctx: PluginContext) {
          error = thrown(() => {
            tapRemote(ctx, SyncH, { endpoint: w.eb, handler: (c) => c.n });
          });
        },
      },
    ]);
    expect([error?.code, error?.pluginIds]).toEqual(["TAP_FAILED", ["sync-tap"]]);
    expect(thrown(() => exposeHooks(w.main, w.ea, [SyncH as HookRef<unknown, unknown>])).code).toBe("TAP_FAILED");
  });

  it("disposing plugin that tapped remotely removes the remote tap", async () => {
    const w = await world();
    await w.win.reconcile([tapper(w.eb, async (c, next) => (await next(c)) + 1)]);
    await tick();
    await expect(w.run(1)).resolves.toBe(11);
    await w.win.reconcile([]);
    await tick();
    await expect(w.run(1)).resolves.toBe(10);
    expect([w.errors, w.winErrors]).toEqual([[], []]);
  });

  it("transport close removes remote taps and continues pending invocations with next", async () => {
    const w = await world();
    await w.win.reconcile([tapper(w.eb, () => new Promise(() => undefined))]);
    await tick();
    const pending = w.run(3);
    await tick();
    w.ta.close();
    await expect(pending).resolves.toBe(30);
    expect(w.errors.map((e) => [e.code, e.pluginIds])).toEqual([["RPC_DISCONNECTED", ["remote:win-tap"]]]);
    await expect(w.run(3)).resolves.toBe(30);
    await w.win.reconcile([]);
    expect(w.winErrors).toEqual([]);
  });

});

describe("remote hook failures", () => {
  it("match and priority apply; a failing remote tap surfaces as TAP_FAILED of the remote owner", async () => {
    const w = await world();
    await w.win.reconcile([
      tapper(w.eb, async (c, next) => (await next(c)) + 1, { match: (c) => c.n > 1, priority: 1, id: "plus" }),
      tapper(w.eb, () => Promise.reject(new Error("boom")), { match: (c) => c.n === 5, before: ["remote:plus"], after: [], id: "boom" }),
    ]);
    await tick();
    await expect(w.run(1)).resolves.toBe(10);
    await expect(w.run(2)).resolves.toBe(21);
    const err = await rejection(w.run(5));
    expect([err.code, err.pluginIds]).toEqual(["TAP_FAILED", ["remote:boom"]]);
  });

  it("calling next twice, unsendable ctx and unsendable results are errors, not hangs", async () => {
    const w = await world();
    await w.win.reconcile([
      tapper(w.eb, async (c, next) => {
        if (c.n === 1) {
          await next(c);
          return next(c);
        }
        if (c.n === 2) return next({ n: 2, f: () => undefined });
        return (await next(c)) + 0;
      }),
    ]);
    await tick();
    expect((await rejection(w.run(1))).code).toBe("TAP_FAILED");
    expect((await rejection(w.run(2))).message).toContain("Cannot send hook context");
    expect((await rejection(w.run(3, { f: () => undefined }))).message).toContain("Cannot send context");
    const bad = await rejection(w.main.run(H, { n: 4 }, () => Promise.resolve((() => 1) as unknown as number)));
    expect(bad.message).toContain("Cannot send hook result");
  });

  it("tapping an unexposed hook reports on the tapping side; unknown requests and stop are handled", async () => {
    const w = await world();
    const other = createHook<Ctx, Promise<number>>("h.other");
    await w.win.reconcile([
      {
        id: "lost",
        version: "1.0.0",
        setup(ctx) {
          tapRemote(ctx, other, { endpoint: w.eb, handler: (c, next) => next(c) });
        },
      },
    ]);
    await tick();
    expect(w.winErrors.map((e) => e.code)).toEqual(["RPC_REMOTE_ERROR"]);
    await w.win.reconcile([]);
    expect((await rejection(w.eb.call("loom:hook:h.compute", "weird", [{}]))).code).toBe("RPC_REMOTE_ERROR");
    await w.win.reconcile([tapper(w.eb, async (c, next) => (await next(c)) + 1)]);
    await tick();
    w.stop();
    await expect(w.run(1)).resolves.toBe(10);
    await w.win.reconcile([]);
    expect(w.winErrors.map((e) => e.code)).toEqual(["RPC_REMOTE_ERROR", "TAP_FAILED"]);
  });

  it("a late tap-next after timeout is answered with RPC_CANCELLED", async () => {
    vi.useFakeTimers();
    const w = await world();
    const seen: string[] = [];
    let release: () => void = () => undefined;
    await w.win.reconcile([
      tapper(
        w.eb,
        async (c, next) => {
          await new Promise<void>((r) => (release = r));
          return next(c).catch((e: unknown) => (seen.push((e as LoomError).code), -1));
        },
        { timeoutMs: 10 },
      ),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    const result = w.run(1);
    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toBe(10);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(["RPC_CANCELLED"]);
  });
});
