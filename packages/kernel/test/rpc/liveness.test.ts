import { afterEach, describe, expect, it, vi } from "vitest";
import { createHook } from "../../src/core/definitions.js";
import type { LoomError } from "../../src/core/errors.js";
import { createKernel } from "../../src/core/kernel.js";
import type { Kernel } from "../../src/core/kernel.js";
import type { PluginDefinition } from "../../src/core/types.js";
import { createRpcEndpoint } from "../../src/rpc/endpoint.js";
import type { RpcEndpoint } from "../../src/rpc/endpoint.js";
import { createMemoryTransportPair } from "../../src/rpc/memory-transport.js";
import type { MemoryTransport } from "../../src/rpc/memory-transport.js";
import { startTimer } from "../../src/rpc/platform.js";
import { exposeHooks } from "../../src/rpc/remote-hooks.js";
import { tapRemote } from "../../src/rpc/remote-taps.js";
import { rejection } from "../core/kernel-helpers.js";

const H = createHook<{ n: number }, Promise<number>>("h.live");
const tick = (): Promise<void> => new Promise((r) => startTimer(r, 0));

interface Pair {
  main: Kernel;
  win: Kernel;
  ea: RpcEndpoint;
  eb: RpcEndpoint;
  ta: MemoryTransport;
  errors: LoomError[];
  run: (n: number) => Promise<number>;
}

async function pair(local: PluginDefinition[] = []): Promise<Pair> {
  const [ta, tb] = createMemoryTransportPair();
  const ea = createRpcEndpoint(ta);
  const eb = createRpcEndpoint(tb);
  const main = createKernel();
  await main.reconcile(local);
  const errors: LoomError[] = [];
  main.on<LoomError>("kernel.error", (e) => errors.push(e));
  exposeHooks(main, ea, [H]);
  const run = (n: number): Promise<number> => main.run(H, { n }, (c) => Promise.resolve(c.n * 10));
  return { main, win: createKernel(), ea, eb, ta, errors, run };
}

function remoteTap(eb: RpcEndpoint, fn: (c: { n: number }, next: (c: { n: number }) => Promise<number>) => Promise<number>, timeoutMs?: number): PluginDefinition {
  return {
    id: "win-tap",
    version: "1.0.0",
    setup(ctx) {
      tapRemote(ctx, eb, H, timeoutMs === undefined ? {} : { timeoutMs }, fn);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("rpc liveness on close (close and bye)", () => {
  it("run that reaches a remote tap after close continues with next and reports RPC_DISCONNECTED", async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((r) => (open = r));
    const local: PluginDefinition = {
      id: "local",
      version: "1.0.0",
      setup(ctx) {
        ctx.tap(H, { priority: 1 }, async (c, next) => {
          await gate;
          return next(c);
        });
      },
    };
    const p = await pair([local]);
    await p.win.reconcile([remoteTap(p.eb, async (c, next) => (await next(c)) + 1)]);
    await tick();
    const result = p.run(2);
    await tick();
    p.ta.close();
    open();
    await expect(result).resolves.toBe(20);
    expect(p.errors.map((e) => [e.code, e.pluginIds])).toEqual([["RPC_DISCONNECTED", ["remote:win-tap"]]]);
  });

  it("peer calls reject with RPC_DISCONNECTED after the other endpoint closes", async () => {
    const p = await pair();
    let signal: { aborted: boolean } | undefined;
    p.eb.handle("hang", (_m, _a, s) => {
      signal = s;
      return new Promise(() => undefined);
    });
    p.ea.handle("hang", () => new Promise(() => undefined));
    const toClosing = p.ea.call("hang", "m", []);
    const fromClosing = p.eb.call("hang", "m", []);
    await tick();
    p.eb.close();
    expect((await rejection(fromClosing)).code).toBe("RPC_DISCONNECTED");
    expect((await rejection(toClosing)).code).toBe("RPC_DISCONNECTED");
    expect(signal?.aborted).toBe(true);
    expect((await rejection(p.ea.call("hang", "m", []))).code).toBe("RPC_DISCONNECTED");
  });

  it("remote taps are removed when the tapping endpoint closes", async () => {
    vi.useFakeTimers();
    const p = await pair();
    await p.win.reconcile([remoteTap(p.eb, async (c, next) => (await next(c)) + 1)]);
    await vi.advanceTimersByTimeAsync(0);
    await expect(p.run(1)).resolves.toBe(11);
    p.eb.close();
    await vi.advanceTimersByTimeAsync(0);
    const result = p.run(1);
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toBe(10);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(p.errors).toEqual([]);
  });

  it("late tap-result after timeout is ignored", async () => {
    vi.useFakeTimers();
    const p = await pair();
    let release: () => void = () => undefined;
    await p.win.reconcile([remoteTap(p.eb, () => new Promise<number>((r) => {
          release = () => {
            r(99);
          };
        }), 10)]);
    await vi.advanceTimersByTimeAsync(0);
    const first = p.run(1);
    await vi.advanceTimersByTimeAsync(10);
    await expect(first).resolves.toBe(10);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(p.errors.map((e) => e.code)).toEqual(["HOOK_TIMEOUT"]);
    const second = p.run(2);
    await vi.advanceTimersByTimeAsync(0);
    release();
    await vi.advanceTimersByTimeAsync(0);
    await expect(second).resolves.toBe(99);
  });
});
