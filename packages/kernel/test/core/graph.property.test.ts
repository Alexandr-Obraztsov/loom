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
        for (const [raw, isOptional] of edges[i] ?? []) {
          (isOptional ? optionalDependsOn : dependsOn)[name(raw % i)] = "*";
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

/** Like the DAG above, but optional edges may also point at plugins that are absent. */
const withAbsentOptionals = dagArb.chain((plugins) =>
  fc.tuple(
    fc.constant(plugins),
    fc.array(fc.tuple(fc.nat(), fc.nat({ max: 3 })), { maxLength: 10 }),
  ),
);

describe("resolveOrder properties: absent optionals and cycles", () => {
  it("reports exactly the absent optional dependencies and still orders the rest", () => {
    fc.assert(
      fc.property(withAbsentOptionals, ([plugins, picks]) => {
        if (plugins.length === 0) return true;
        const extended = plugins.map((pl) => ({ ...pl, optionalDependsOn: { ...pl.optionalDependsOn } }));
        const expected = new Map<string, Set<string>>();
        for (const [raw, k] of picks) {
          const target = extended[raw % extended.length];
          if (!target) continue;
          const ghost = `ghost${String(k)}`;
          target.optionalDependsOn[ghost] = "*";
          (expected.get(target.id) ?? expected.set(target.id, new Set()).get(target.id))?.add(ghost);
        }
        const { order, skippedOptional } = resolveOrder(extended);
        if (order.length !== extended.length) return false;
        if (skippedOptional.size !== expected.size) return false;
        return [...expected].every(([id, ghosts]) => [...(skippedOptional.get(id) ?? [])].sort().join() === [...ghosts].sort().join());
      }),
      { numRuns: 300 },
    );
  });

  it("a back edge turns any DAG into DEPENDENCY_CYCLE whose path follows real dependencies", () => {
    fc.assert(
      fc.property(
        dagArb.filter((d) => d.length >= 2),
        fc.nat(),
        (plugins, raw) => {
          const last = plugins.length - 1;
          const from = raw % last;
          // the last plugin depends on `from`; make `from` depend on the last one
          const edited = plugins.map((pl, i) =>
            i === from ? { ...pl, dependsOn: { ...pl.dependsOn, [name(last)]: "*" } } : pl,
          );
          const closing = edited.map((pl, i) =>
            i === last ? { ...pl, dependsOn: { ...pl.dependsOn, [name(from)]: "*" } } : pl,
          );
          try {
            resolveOrder(closing);
          } catch (e) {
            const err = e as { code: string; pluginIds: string[] };
            if (err.code !== "DEPENDENCY_CYCLE") return false;
            const byName = new Map(closing.map((pl) => [pl.id, pl]));
            const cycle = err.pluginIds;
            return cycle.every((id, i) => {
              const next = cycle[(i + 1) % cycle.length] as string;
              const pl = byName.get(id);
              return pl !== undefined && (next in (pl.dependsOn ?? {}) || next in (pl.optionalDependsOn ?? {}));
            });
          }
          return false;
        },
      ),
      { numRuns: 300 },
    );
  });
});
