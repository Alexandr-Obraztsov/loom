/// <reference types="node" />
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { createHook, createServiceRef } from "../src/core/definitions.js";
import { createHookRegistry } from "../src/core/hooks.js";
import { createKernel } from "../src/core/kernel.js";
import { createServiceRegistry } from "../src/core/services.js";
import { buildTree } from "../src/core/tree.js";
import type { ExtensionContext } from "../src/core/types.js";
import type { Counter } from "./perf-fixtures.js";
import { measure, perfPlugin, perfPlugins, pid, pluginHook, treeFixture } from "./perf-fixtures.js";

/**
 * CI guards: generous ceilings that catch complexity regressions, not micro-slowdowns.
 * Measured numbers live in docs/kernel/README.md and come from `pnpm bench`.
 */

const N = 200;
const use = ((): never => {
  throw new Error("unused");
}) as ExtensionContext<never>["use"];

describe("performance guards: kernel", () => {
  it(`cold reconcile of ${String(N)} plugins (3 deps each) < 50 ms`, async () => {
    const plugins = perfPlugins(N);
    const ms = await measure(1, 7, async () => {
      const kernel = createKernel();
      await kernel.reconcile(plugins);
      await kernel.dispose();
    });
    expect(ms, `cold reconcile + dispose took ${ms.toFixed(2)} ms`).toBeLessThan(50);
  });

  it(`reload of 1 leaf among ${String(N)} < 5 ms`, async () => {
    const plugins = perfPlugins(N);
    const kernel = createKernel();
    await kernel.reconcile(plugins);
    const leaf = N - 1;
    const variants = [perfPlugin(leaf, 3, "1.0.1"), perfPlugin(leaf, 3, "1.0.0")].map((def) => [...plugins.slice(0, leaf), def]);
    let flip = 0;
    const reloaded: string[][] = [];
    const ms = await measure(20, 7, async () => {
      const diff = await kernel.reconcile(variants[flip++ % 2] ?? []);
      reloaded.push(diff.reloaded);
    });
    expect(new Set(reloaded.map((r) => r.join()))).toEqual(new Set([pid(leaf)]));
    expect(ms, `leaf reload took ${ms.toFixed(3)} ms`).toBeLessThan(5);
    await kernel.dispose();
  });

  it("cold reconcile + dispose of 2000 plugins < 250 ms (catches O(n²) bookkeeping)", async () => {
    const plugins = perfPlugins(2000);
    const ms = await measure(1, 3, async () => {
      const kernel = createKernel();
      await kernel.reconcile(plugins);
      await kernel.dispose();
    });
    expect(ms, `2000 plugins took ${ms.toFixed(1)} ms`).toBeLessThan(250);
  });

  it("orphan reasons for a detached chain of 3000 extensions < 300 ms (linear walk)", () => {
    const entries = Array.from({ length: 3000 }, (_, k) => ({
      pluginId: `p-${String(k % 7)}`,
      ext: { id: `e${String(k)}`, attachTo: { id: k === 0 ? "ghost" : `e${String(k - 1)}`, input: "slot" }, inputs: { slot: { multiple: true } }, factory: () => k },
      override: false,
    }));
    const start = performance.now();
    const result = buildTree(entries, {}, use);
    const ms = performance.now() - start;
    expect(result.orphans).toHaveLength(3000);
    expect(ms, `orphan reasons took ${ms.toFixed(1)} ms`).toBeLessThan(300);
  });

});

describe("performance guards: tree, services, hooks", () => {
  it("rebuild after 1 leaf change calls factory for at most depth + 1 nodes", () => {
    const tree = treeFixture(2000);
    const first = buildTree(tree.entries, {}, use);
    expect(tree.calls()).toBe(2000);
    tree.reset();
    const second = buildTree(tree.withLeafChanged(), {}, use, first);
    expect(second.errors).toEqual([]);
    expect(tree.calls()).toBeGreaterThan(0);
    expect(tree.calls()).toBeLessThanOrEqual(tree.leafDepth + 1);
  });

  it("live proxy call time < 8x a direct call over 1e6 calls (median of 7)", () => {
    const ref = createServiceRef<Counter>("perf.counter");
    const registry = createServiceRegistry({ kernelOwner: "kernel" });
    let total = 0;
    const impl: Counter = { add: (n) => (total += n) };
    registry.provide(ref, impl, "kernel");
    const proxy = registry.use(ref, "consumer", new Set(["kernel"]));
    // One loop, created inside this test and used only by it: direct and proxy calls go through the same
    // call site (bimorphic, so the direct call cannot be inlined away), and the warm-up below is part of the
    // test, so the result does not depend on other tests or on their order.
    const time = (target: Counter): number => {
      const start = performance.now();
      for (let i = 0; i < 1e6; i++) target.add(1);
      return performance.now() - start;
    };
    for (let i = 0; i < 5; i++) {
      time(impl);
      time(proxy);
    }
    const median = (run: () => number): number => {
      const samples = Array.from({ length: 7 }, run).sort((x, y) => x - y);
      return samples[3] ?? 0;
    };
    const directTime = median(() => time(impl));
    const proxyTime = median(() => time(proxy));
    expect(total).toBe(24e6);
    expect(proxyTime, `proxy ${proxyTime.toFixed(2)} ms vs direct ${directTime.toFixed(2)} ms per 1e6 calls (ratio ${(proxyTime / directTime).toFixed(2)})`).toBeLessThan(8 * directTime);
  });

  it("20-tap async run < 0.05 ms per run over 10 000 runs", async () => {
    const reg = createHookRegistry({ onError: () => undefined });
    for (let t = 0; t < 20; t++) reg.tap(pluginHook, `o${String(t)}`, { priority: t % 3 }, (c, next) => next(c + 1));
    const fallback = (c: number): Promise<number> => Promise.resolve(c);
    expect(await reg.run(pluginHook, 0, fallback)).toBe(20);
    const ms = await measure(10_000, 5, () => reg.run(pluginHook, 0, fallback));
    expect(ms, `20-tap async run took ${(ms * 1000).toFixed(2)} µs`).toBeLessThan(0.05);
  });
});

const syncHook = createHook<number, number>("perf.sync", { mode: "sync" });

describe("performance guards: hooks in setup", () => {
  it("tap + run per plugin in setup <= 3x batch mode, floored at 4 ms, over 2000 taps of one hook", async ({ annotate }) => {
    const taps = 2000;
    const fill = (reg: ReturnType<typeof createHookRegistry>, i: number): void => {
      reg.tap(syncHook, `o${String(i)}`, { priority: i % 5 }, (c) => c); // answers without next(): the run costs ordering, not the chain
    };
    const fallback = (c: number): number => c;
    const batchMode = (): number => {
      const reg = createHookRegistry({ onError: () => undefined });
      const t0 = performance.now();
      const end = reg.defer();
      for (let i = 0; i < taps; i++) fill(reg, i);
      end();
      for (let i = 0; i < taps; i++) reg.run(syncHook, 0, fallback);
      return performance.now() - t0;
    };
    const setupMode = (): number => {
      const reg = createHookRegistry({ onError: () => undefined });
      const t0 = performance.now();
      for (let i = 0; i < taps; i++) {
        fill(reg, i);
        reg.run(syncHook, 0, fallback);
      }
      return performance.now() - t0;
    };
    const median = (f: () => number): number =>
      [f(), f(), f(), f(), f()].sort((a, b) => a - b)[2] as number;
    median(batchMode);
    const batch = median(batchMode);
    const inSetup = median(setupMode);
    // batch mode takes ~1 ms, so its timer noise alone could break a strict 3x; the floor keeps a 12 ms ceiling
    // (the quadratic re-sort this guards against costs ~800 ms)
    await annotate(`setup/batch ratio ${(inSetup / batch).toFixed(2)} (${inSetup.toFixed(1)} ms vs ${batch.toFixed(1)} ms)`);
    expect(
      inSetup,
      `setup ${inSetup.toFixed(1)} ms vs batch ${batch.toFixed(1)} ms (ratio ${(inSetup / batch).toFixed(2)})`,
    ).toBeLessThan(3 * Math.max(batch, 4));
  });
});
