/// <reference types="node" />
import { performance } from "node:perf_hooks";

import { createHook, createServiceRef } from "../src/core/definitions.js";
import type { TreeEntry } from "../src/core/tree-index.js";
import type { ExtensionDefinition, HookRef, PluginDefinition, ServiceRef } from "../src/core/types.js";

/** Shared workload for `bench/*.bench.ts` and the CI guards in `perf.test.ts`. */

export interface Counter {
  add(n: number): number;
}

export const pluginHook: HookRef<number, Promise<number>> = createHook<number, Promise<number>>("perf.hook", {
  mode: "async",
});

const svc = (i: number): ServiceRef<Counter> => createServiceRef<Counter>(`perf.svc.${String(i)}`);
export const pid = (i: number): string => `p-${String(i)}`;

/** Up to `deps` distinct earlier plugins, spread so the graph is neither a chain nor a star. */
function depsOf(i: number, deps: number): number[] {
  const out = new Set<number>();
  for (let k = 1; out.size < Math.min(deps, i) && k <= i; k++) out.add((i * 7 + k * 13) % i);
  return [...out].sort((a, b) => a - b);
}

/**
 * Plugin `i` of a set of `n`: depends on up to `deps` earlier plugins, provides a service, uses
 * one dependency's service, taps a shared async hook, listens to an event and contributes one
 * extension attached under its first dependency's extension (plugin 0 owns the root "app").
 * Nobody depends on plugin n-1, so it is a leaf. `version` lets a caller make a new definition.
 */
export function perfPlugin(i: number, deps = 3, version = "1.0.0"): PluginDefinition {
  const parents = depsOf(i, deps);
  const first = parents[0];
  const ext: ExtensionDefinition =
    first === undefined
      ? { id: "app", inputs: { slot: { multiple: true } }, factory: () => "app" }
      : { id: `ext-${String(i)}`, attachTo: { id: first === 0 ? "app" : `ext-${String(first)}`, input: "slot" }, inputs: { slot: { multiple: true } }, factory: () => i };
  return {
    id: pid(i),
    version,
    dependsOn: Object.fromEntries(parents.map((d) => [pid(d), "^1.0.0"])),
    extensions: [ext],
    setup(ctx) {
      let total = 0;
      ctx.provide(svc(i), { add: (n) => (total += n) });
      if (first !== undefined) ctx.use(svc(first)).add(1);
      ctx.tap(pluginHook, { priority: i % 5 }, (c, next) => next(c + 1));
      ctx.on("perf.event", () => undefined);
    },
  };
}

export function perfPlugins(n: number, deps = 3): PluginDefinition[] {
  return Array.from({ length: n }, (_, i) => perfPlugin(i, deps));
}

export interface TreeFixture {
  readonly entries: TreeEntry[];
  /** Factory calls since the last `reset()`. */
  calls(): number;
  reset(): void;
  /** Entries with the deepest extension replaced by a new definition object. */
  withLeafChanged(): TreeEntry[];
  /** Depth (root = 0) of the extension `withLeafChanged` replaces. */
  readonly leafDepth: number;
}

/** `n` extensions in a tree with fan-out `fanout`; extension k hangs under extension floor((k-1)/fanout). */
export function treeFixture(n: number, fanout = 4): TreeFixture {
  let calls = 0;
  const id = (k: number): string => (k === 0 ? "app" : `e${String(k)}`);
  const def = (k: number): ExtensionDefinition => ({
    id: id(k),
    inputs: { slot: { multiple: true } },
    ...(k === 0 ? {} : { attachTo: { id: id(Math.floor((k - 1) / fanout)), input: "slot" } }),
    factory: () => (calls++, k),
  });
  const entries = Array.from({ length: n }, (_, k) => ({ pluginId: `t-${String(k % 50)}`, ext: def(k), override: false }));
  let leafDepth = 0;
  for (let k = n - 1; k > 0; k = Math.floor((k - 1) / fanout)) leafDepth++;
  return {
    entries,
    calls: () => calls,
    reset: () => void (calls = 0),
    withLeafChanged: () => entries.map((e, k) => (k === n - 1 ? { ...e, ext: def(k) } : e)),
    leafDepth,
  };
}

/** Milliseconds per iteration: median of `rounds` timed batches of `iterations` calls, after one warm-up batch. */
export async function measure(iterations: number, rounds: number, body: () => unknown): Promise<number> {
  const batch = async (): Promise<number> => {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      const r = body();
      if (r instanceof Promise) await r;
    }
    return (performance.now() - start) / iterations;
  };
  await batch();
  const times: number[] = [];
  for (let r = 0; r < rounds; r++) times.push(await batch());
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)] as number;
}
