import { bench, describe } from "vitest";

import { createKernel } from "../src/core/kernel.js";
import { perfPlugin, perfPlugins } from "../test/perf-fixtures.js";

const N = 200;
const plugins = perfPlugins(N);

const warm = createKernel();
await warm.reconcile(plugins);
const leaf = N - 1;
const variants = [perfPlugin(leaf, 3, "1.0.1"), perfPlugin(leaf, 3, "1.0.0")].map((def) => [...plugins.slice(0, leaf), def]);
let flip = 0;

describe("kernel", () => {
  bench(`reconcile ${String(N)} plugins, 3 deps each, cold`, async () => {
    const kernel = createKernel();
    await kernel.reconcile(plugins);
  });
  bench(`reload 1 leaf plugin among ${String(N)}`, async () => {
    await warm.reconcile(variants[flip++ % 2] ?? []);
  });
});
