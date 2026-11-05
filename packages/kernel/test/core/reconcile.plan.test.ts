import { describe, expect, it } from "vitest";

import { planReconcile, presentOptional } from "../../src/core/reconcile.js";
import { ids, plugin } from "./kernel-helpers.js";

describe("planReconcile", () => {
  const log: string[] = [];
  const a = plugin(log, "a");
  const b = plugin(log, "b", { deps: ["a"] });
  const c = plugin(log, "c", { optional: ["a", "z"] });

  it("plans nothing for an unchanged set", () => {
    const plan = planReconcile([a, b], [b, a]);
    expect(plan.teardown).toEqual([]);
    expect(plan.setup).toEqual([]);
    expect(ids(plan.order)).toEqual(["a", "b"]);
  });

  it("forced ids reload with their dependents even when the object is the same", () => {
    const plan = planReconcile([a, b, c], [a, b, c], { force: new Set(["a"]) });
    expect(ids(plan.teardown)).toEqual(["a", "b", "c"]);
    expect(ids(plan.setup)).toEqual(["a", "b", "c"]);
    expect(plan.diff.reloaded).toEqual(["a", "b", "c"]);
    expect(plan.diff.requiresRestart).toEqual([]);
  });

  it("a different definition object with the same version counts as a change", () => {
    const mutable = { ...a };
    const next = planReconcile([mutable], [{ ...mutable }]);
    expect(next.diff.reloaded).toEqual(["a"]);
  });

  it("presentOptional lists only optional dependencies that are active, sorted", () => {
    expect(presentOptional(c, new Set(["z", "a", "q"]))).toEqual(["a", "z"]);
    expect(presentOptional(a, new Set(["a"]))).toEqual([]);
  });
});
