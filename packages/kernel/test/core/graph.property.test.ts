import fc from "fast-check";
import { describe, it } from "vitest";
import { resolveOrder } from "../../src/core/graph.js";
import type { PluginDefinition } from "../../src/core/types.js";

const name = (i: number): string => `p${String(i).padStart(2, "0")}`;

/** Random DAG: plugin i may only depend on plugins with a smaller index. */
const dagArb = fc
  .integer({ min: 0, max: 25 })
  .chain((n) =>
    fc.tuple(
      fc.constant(n),
      fc.array(fc.array(fc.tuple(fc.nat(), fc.boolean()), { maxLength: 4 }), { minLength: n, maxLength: n }),
    ),
  )
  .map(([n, edges]) => {
    const plugins: PluginDefinition[] = [];
    for (let i = 0; i < n; i++) {
      const dependsOn: Record<string, string> = {};
      const optionalDependsOn: Record<string, string> = {};
      if (i > 0) {
        for (const [raw, optional] of edges[i] ?? []) {
          (optional ? optionalDependsOn : dependsOn)[name(raw % i)] = "*";
        }
      }
      plugins.push({ id: name(i), version: "1.0.0", dependsOn, optionalDependsOn });
    }
    return plugins;
  });

const dagWithShuffle = dagArb.chain((plugins) =>
  fc.tuple(
    fc.constant(plugins),
    fc.shuffledSubarray(plugins, { minLength: plugins.length, maxLength: plugins.length }),
  ),
);

describe("resolveOrder properties", () => {
  it("places every plugin after its present dependencies and returns a permutation", () => {
    fc.assert(
      fc.property(dagArb, (plugins) => {
        const { order } = resolveOrder(plugins);
        const position = new Map(order.map((pl, i) => [pl.id, i]));
        if (order.length !== plugins.length || position.size !== plugins.length) return false;
        if (!plugins.every((pl) => position.has(pl.id))) return false;
        return plugins.every((pl) =>
          [...Object.keys(pl.dependsOn ?? {}), ...Object.keys(pl.optionalDependsOn ?? {})].every(
            (dep) => (position.get(dep) ?? -1) < (position.get(pl.id) ?? -1),
          ),
        );
      }),
      { numRuns: 500 },
    );
  });

  it("is identical for any shuffle of the input", () => {
    fc.assert(
      fc.property(dagWithShuffle, ([plugins, shuffled]) => {
        const a = resolveOrder(plugins).order.map((x) => x.id);
        const b = resolveOrder(shuffled).order.map((x) => x.id);
        return a.join() === b.join();
      }),
      { numRuns: 500 },
    );
  });
});
