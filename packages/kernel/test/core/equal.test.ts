import { describe, expect, it } from "vitest";
import { deepEqual } from "../../src/core/equal.js";

describe("deepEqual", () => {
  it("compares plain data structurally", () => {
    expect(deepEqual({ a: [1, { b: "x" }], c: null }, { c: null, a: [1, { b: "x" }] })).toBe(true);
    expect(deepEqual(Object.create(null) as object, {})).toBe(true);
    expect(deepEqual(Number.NaN, Number.NaN)).toBe(true);
    expect(deepEqual(undefined, undefined)).toBe(true);
  });

  it("detects differences", () => {
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual({ a: 1 }, { b: 1 })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual([1, 2], [1])).toBe(false);
    expect(deepEqual([1], { 0: 1 })).toBe(false);
    expect(deepEqual({ 0: 1 }, [1])).toBe(false);
    expect(deepEqual(1, "1")).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual({}, undefined)).toBe(false);
  });

  it("compares non-plain objects by identity", () => {
    const d = new Date(0);
    expect(deepEqual(d, d)).toBe(true);
    expect(deepEqual(new Date(0), new Date(0))).toBe(false);
    expect(deepEqual(new Map(), {})).toBe(false);
  });
});
