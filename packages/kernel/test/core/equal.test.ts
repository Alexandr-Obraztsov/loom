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

describe("deepEqual primitives and prototypes", () => {
  it("separates -0 from 0 (Object.is semantics, also inside structures)", () => {
    expect(deepEqual(-0, 0)).toBe(false);
    expect(deepEqual({ a: -0 }, { a: 0 })).toBe(false);
    expect(deepEqual([0], [0])).toBe(true);
  });

  it("never equates two distinct symbols, even with the same description", () => {
    expect(deepEqual(Symbol("a"), Symbol("a"))).toBe(false);
    const s = Symbol("a");
    expect(deepEqual({ k: s }, { k: s })).toBe(true);
  });

  it("does not equate instances of different classes with equal fields", () => {
    class A { x = 1; }
    class B { x = 1; }
    expect(deepEqual(new A(), new B())).toBe(false);
    expect(deepEqual(new A(), { x: 1 })).toBe(false);
    const a = new A();
    expect(deepEqual(a, a)).toBe(true);
    expect(deepEqual(new A(), new A())).toBe(false);
  });
});
