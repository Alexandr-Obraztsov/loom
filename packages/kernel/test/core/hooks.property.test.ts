import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { LoomError } from "../../src/core/errors.js";
import { createHook } from "../../src/core/definitions.js";
import { createHookRegistry } from "../../src/core/hooks.js";

const hook = createHook<string[], string[]>("h.prop", { mode: "sync" });

/** Acyclic by construction: constraints only point along a hidden permutation. */
const scenario = fc
  .record({
    n: fc.integer({ min: 1, max: 9 }),
    perm: fc.infiniteStream(fc.nat()),
    priorities: fc.array(fc.integer({ min: -3, max: 3 }), { minLength: 9, maxLength: 9 }),
    edges: fc.array(fc.tuple(fc.nat(8), fc.nat(8), fc.boolean(), fc.boolean()), { maxLength: 14 }),
  })
  .map(({ n, priorities, edges }) => {
    const owners = Array.from({ length: n }, (_, i) => "p" + String(i));
    // rank = index, so a constraint x -> y is legal only when x < y in rank order.
    const before = owners.map(() => [] as string[]);
    const after = owners.map(() => [] as string[]);
    const constraints: [string, string][] = [];
    for (const [a, b, viaBefore] of edges) {
      const x = a % n;
      const y = b % n;
      if (x >= y) continue;
      const [fromO, toO] = [owners[x] as string, owners[y] as string];
      if (viaBefore) (before[x] as string[]).push(toO);
      else (after[y] as string[]).push(fromO);
      constraints.push([fromO, toO]);
    }
    return { owners, priorities, before, after, constraints };
  });

describe("hook ordering properties", () => {
  it("every acyclic constraint holds in taps() order and each tap runs exactly once", () => {
    fc.assert(
      fc.property(scenario, fc.integer({ min: 0, max: 1000 }), (s, shuffleSeed) => {
        const errors: unknown[] = [];
        const reg = createHookRegistry({ onError: (e) => errors.push(e) });
        // register in a seed-dependent rotation to vary registration order
        const idx = s.owners.map((_, i) => i);
        const rot = shuffleSeed % idx.length;
        const regOrder = [...idx.slice(rot), ...idx.slice(0, rot)];
        for (const i of regOrder) {
          reg.tap(
            hook,
            s.owners[i] as string,
            {
              priority: s.priorities[i] as number,
              before: s.before[i] as string[],
              after: s.after[i] as string[],
            },
            (c, next) => next([...c, s.owners[i] as string]),
          );
        }
        const order = reg.taps(hook).map((t) => t.owner);
        expect(order).toHaveLength(s.owners.length);
        expect(new Set(order).size).toBe(s.owners.length);
        for (const [from, to] of s.constraints) {
          expect(order.indexOf(from)).toBeLessThan(order.indexOf(to));
        }
        const ran = reg.run(hook, [], (c) => c);
        expect(ran).toEqual(order);
        expect(reg.run(hook, [], (c) => c)).toEqual(order);
        expect(errors).toEqual([]);
      }),
      { numRuns: 400 },
    );
  });

  it("without constraints, order is priority desc then registration", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -3, max: 3 }), { minLength: 1, maxLength: 12 }),
        (priorities) => {
          const reg = createHookRegistry({ onError: () => undefined });
          priorities.forEach((p, i) =>
            reg.tap(hook, "p" + String(i), { priority: p }, (c, next) => next(c)),
          );
          const expected = priorities
            .map((p, i) => ({ p, i }))
            .sort((a, b) => b.p - a.p || a.i - b.i)
            .map((x) => "p" + String(x.i));
          expect(reg.taps(hook).map((t) => t.owner)).toEqual(expected);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("hook ordering properties (contradictions)", () => {
  it("arbitrary (possibly contradictory) constraints still run every tap exactly once", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.nat(5),
            fc.array(fc.nat(5), { maxLength: 3 }),
            fc.array(fc.nat(5), { maxLength: 3 }),
          ),
          {
            minLength: 1,
            maxLength: 8,
          },
        ),
        (specs) => {
          const reg = createHookRegistry({ onError: () => undefined });
          specs.forEach(([prio, b, a], i) =>
            reg.tap(
              hook,
              "p" + String(i % 6),
              {
                priority: prio,
                before: b.map((x) => "p" + String(x)),
                after: a.map((x) => "p" + String(x)),
              },
              (c, next) => next([...c, "#" + String(i)]),
            ),
          );
          const ran = reg.run(hook, [], (c) => c);
          expect([...ran].sort()).toEqual(specs.map((_, i) => "#" + String(i)).sort());
        },
      ),
      { numRuns: 300 },
    );
  });

  it("with contradictions, every non-dropped constraint holds and onError fired when a cycle existed", () => {
    const pair = fc.tuple(fc.nat(4), fc.nat(4));
    fc.assert(
      fc.property(fc.array(pair, { minLength: 1, maxLength: 10 }), (edges) => {
        const errors: LoomError[] = [];
        const reg = createHookRegistry({ onError: (e) => errors.push(e) });
        for (let i = 0; i < 5; i++) {
          const before = edges.filter(([a]) => a === i).map(([, b]) => "p" + String(b));
          reg.tap(hook, "p" + String(i), { before }, (c, next) => next([...c, "p" + String(i)]));
        }
        const order = reg.taps(hook).map((t) => t.owner);
        const pos = (o: string) => order.indexOf(o);
        const unmet = edges.filter(
          ([a, b]) => a !== b && pos("p" + String(a)) > pos("p" + String(b)),
        );
        // a violated constraint must have been reported
        if (unmet.length > 0) expect(errors.length).toBeGreaterThan(0);
        // a reachability cycle among declared edges forces at least one report
        const adj = edges.filter(([a, b]) => a !== b);
        const reach = (from: number, to: number, seen = new Set<number>()): boolean =>
          adj.some(([a, b]) => {
            if (a !== from || seen.has(b)) return false;
            seen.add(b);
            return b === to || reach(b, to, seen);
          });
        const cyclic = adj.some(([a]) => reach(a, a));
        if (cyclic) expect(errors.length).toBeGreaterThan(0);
        for (const e of errors) expect(e.code).toBe("TAP_FAILED");
        expect(reg.run(hook, [], (c) => c)).toHaveLength(5);
      }),
      { numRuns: 300 },
    );
  });
});
