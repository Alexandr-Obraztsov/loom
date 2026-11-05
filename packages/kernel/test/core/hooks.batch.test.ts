import { describe, expect, it } from "vitest";

import { createHook } from "../../src/core/definitions.js";
import type { LoomError } from "../../src/core/errors.js";
import { createHookRegistry } from "../../src/core/hooks.js";

const sync = createHook<number, number>("b.sync", { mode: "sync" });
const other = createHook<number, number>("b.other", { mode: "sync" });
const pass = (c: number, n: (c: number) => number): number => n(c);

function setup(rankOf?: (owner: string) => number) {
  const errors: LoomError[] = [];
  const reg = createHookRegistry({ onError: (e) => errors.push(e), ...(rankOf ? { rankOf } : {}) });
  const owners = (hook = sync): string[] => reg.taps(hook).map((t) => t.owner);
  return { reg, errors, owners };
}

describe("hook registry batches (defer)", () => {
  it("orders and reports once, when the batch ends", () => {
    const { reg, errors, owners } = setup();
    const end = reg.defer();
    reg.tap(sync, { owner: "a", before: ["b"] }, pass);
    reg.tap(sync, { owner: "b", before: ["a"] }, pass);
    reg.tap(sync, { owner: "c", priority: 5 }, pass);
    expect(errors).toHaveLength(0);
    end();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.pluginIds).toEqual(["b", "a"]);
    expect(owners()).toEqual(["c", "a", "b"]);
    end();
    expect(errors).toHaveLength(1);
  });

  it("run and taps inside a batch see the settled order", () => {
    const { reg, errors, owners } = setup();
    const end = reg.defer();
    const seen: string[] = [];
    reg.tap(sync, { owner: "low" }, (c, n) => (seen.push("low"), n(c)));
    reg.tap(sync, { owner: "high", priority: 1 }, (c, n) => (seen.push("high"), n(c)));
    expect(reg.run(sync, 1, (c) => c)).toBe(1);
    expect(seen).toEqual(["high", "low"]);
    expect(owners()).toEqual(["high", "low"]);
    reg.tap(sync, { owner: "x", before: ["y"] }, pass);
    reg.tap(sync, { owner: "y", before: ["x"] }, pass);
    expect(owners()).toEqual(["high", "low", "x", "y"]);
    expect(errors).toHaveLength(1);
    end();
    expect(errors).toHaveLength(1);
  });

  it("nested batches flush only when the outermost ends", () => {
    const { reg, errors } = setup();
    const outer = reg.defer();
    const inner = reg.defer();
    reg.tap(sync, { owner: "a", before: ["b"] }, pass);
    reg.tap(sync, { owner: "b", before: ["a"] }, pass);
    inner();
    inner();
    expect(errors).toHaveLength(0);
    outer();
    expect(errors).toHaveLength(1);
  });

  it("a contradiction that exists only inside the batch is never reported", () => {
    const { reg, errors, owners } = setup();
    const end = reg.defer();
    reg.tap(sync, { owner: "a", before: ["b"] }, pass);
    const off = reg.tap(sync, { owner: "b", before: ["a"] }, pass);
    off();
    off();
    end();
    expect(errors).toHaveLength(0);
    expect(owners()).toEqual(["a"]);
  });

  it("removing every tap inside a batch drops the hook; removeOwner touches only its hooks", () => {
    const { reg, owners } = setup();
    reg.tap(other, { owner: "keep" }, pass);
    const end = reg.defer();
    reg.tap(sync, { owner: "gone" }, pass);
    reg.tap(sync, { owner: "gone", priority: 1 }, pass);
    reg.removeOwner("gone");
    reg.removeOwner("gone");
    end();
    expect(owners()).toEqual([]);
    expect(owners(other)).toEqual(["keep"]);
    expect(reg.run(sync, 3, (c) => c * 2)).toBe(6);
  });

  it("reorder inside a batch applies the new ranks when the batch ends", () => {
    const ranks: Record<string, number> = { a: 0, b: 1 };
    const { reg, owners } = setup((o) => ranks[o] ?? 9);
    reg.tap(sync, { owner: "b" }, pass);
    reg.tap(sync, { owner: "a" }, pass);
    expect(owners()).toEqual(["a", "b"]);
    const end = reg.defer();
    ranks.a = 2;
    reg.reorder();
    end();
    expect(owners()).toEqual(["b", "a"]);
  });
});
