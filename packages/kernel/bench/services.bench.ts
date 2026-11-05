import { bench, describe } from "vitest";

import { createServiceRef } from "../src/core/definitions.js";
import { createServiceRegistry } from "../src/core/services.js";
import type { Counter } from "../test/perf-fixtures.js";

const ref = createServiceRef<Counter>("bench.counter");
const registry = createServiceRegistry({ kernelOwner: "kernel" });
let total = 0;
const impl: Counter = { add: (n) => (total += n) };
registry.provide(ref, impl, "kernel");
const proxy = registry.use(ref, "consumer", new Set(["kernel"]));
const call = (target: Counter): void => {
  for (let i = 0; i < 1000; i++) target.add(1);
};

describe("service call (1000 calls per iteration)", () => {
  bench("direct", () => {
    call(impl);
  });
  bench("through live proxy", () => {
    call(proxy);
  });
});
