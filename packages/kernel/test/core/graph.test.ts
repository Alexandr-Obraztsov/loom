import { describe, expect, it } from "vitest";
import { LoomError } from "../../src/core/errors.js";
import { dependentsOf, resolveOrder } from "../../src/core/graph.js";
import type { PluginDefinition } from "../../src/core/types.js";

function p(
  id: string,
  dependsOn: Record<string, string> = {},
  optionalDependsOn: Record<string, string> = {},
  version = "1.0.0",
): PluginDefinition {
  return { id, version, dependsOn, optionalDependsOn };
}

function caught(fn: () => unknown): LoomError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(LoomError);
    return e as LoomError;
  }
  throw new Error("expected throw");
}

const ids = (plugins: readonly PluginDefinition[]): string[] => plugins.map((x) => x.id);

describe("resolveOrder", () => {
  it("orders dependencies before dependents", () => {
    const { order } = resolveOrder([p("c", { b: "*" }), p("b", { a: "*" }), p("a")]);
    expect(ids(order)).toEqual(["a", "b", "c"]);
  });

  it("order is deterministic: ties broken by id ascending regardless of input order", () => {
    const set = [p("z"), p("m", { z: "*" }), p("a"), p("k")];
    const expected = ["a", "k", "z", "m"];
    expect(ids(resolveOrder(set).order)).toEqual(expected);
    expect(ids(resolveOrder([...set].reverse()).order)).toEqual(expected);
  });

  it("handles plugin ids that collide with Object.prototype members", () => {
    const { order, skippedOptional } = resolveOrder([p("constructor", {}, { toString: "*" }), p("b", { constructor: "*" })]);
    expect(ids(order)).toEqual(["constructor", "b"]);
    expect(skippedOptional.get("constructor")).toEqual(["toString"]);
  });

  it("missing required dependency throws DEPENDENCY_MISSING with both ids", () => {
    const err = caught(() => resolveOrder([p("a", { ghost: "^1.0.0" }), p("b")]));
    expect(err.code).toBe("DEPENDENCY_MISSING");
    expect(err.pluginIds).toEqual(["a", "ghost"]);
    expect(err.details).toEqual({ problems: [{ plugin: "a", dependency: "ghost", required: "^1.0.0" }] });
  });

  it("collects every missing dependency in deterministic order", () => {
    const err = caught(() => resolveOrder([p("b", { y: "*" }), p("a", { x: "*", w: "*" })]));
    expect(err.pluginIds).toEqual(["a", "w", "x", "b", "y"]);
    expect((err.details as { problems: unknown[] }).problems).toHaveLength(3);
  });

  it("version outside range throws DEPENDENCY_VERSION with required range and actual version", () => {
    const err = caught(() => resolveOrder([p("a", { b: "^2.0.0" }), p("b", {}, {}, "1.5.0")]));
    expect(err.code).toBe("DEPENDENCY_VERSION");
    expect(err.pluginIds).toEqual(["a", "b"]);
    expect(err.details).toEqual({ problems: [{ plugin: "a", dependency: "b", required: "^2.0.0", actual: "1.5.0" }] });
  });

  it("accepts prerelease versions against ranges (includePrerelease)", () => {
    expect(() => resolveOrder([p("a", { b: "^1.0.0" }), p("b", {}, {}, "1.1.0-beta.1")])).not.toThrow();
  });

  it("MISSING takes priority over VERSION", () => {
    const err = caught(() => resolveOrder([p("a", { b: "^2.0.0" }), p("b"), p("c", { ghost: "*" })]));
    expect(err.code).toBe("DEPENDENCY_MISSING");
  });

  it("optional dependency absent is skipped and reported in skippedOptional", () => {
    const { order, skippedOptional } = resolveOrder([p("a", {}, { z: "*", y: "*" }), p("b")]);
    expect(ids(order)).toEqual(["a", "b"]);
    expect(skippedOptional.get("a")).toEqual(["y", "z"]);
    expect(skippedOptional.has("b")).toBe(false);
  });

  it("optional dependency present orders before dependent and its version is checked", () => {
    const { order, skippedOptional } = resolveOrder([p("a", {}, { z: "^1.0.0" }), p("z")]);
    expect(ids(order)).toEqual(["z", "a"]);
    expect(skippedOptional.size).toBe(0);
    const err = caught(() => resolveOrder([p("a", {}, { z: "^2.0.0" }), p("z")]));
    expect(err.code).toBe("DEPENDENCY_VERSION");
    expect(err.pluginIds).toEqual(["a", "z"]);
  });

  it("cycle throws DEPENDENCY_CYCLE whose pluginIds are the cycle path in order", () => {
    const err = caught(() => resolveOrder([p("d", { a: "*" }), p("c", { a: "*" }), p("a", { b: "*" }), p("b", { c: "*" })]));
    expect(err.code).toBe("DEPENDENCY_CYCLE");
    expect(err.pluginIds).toEqual(["a", "b", "c"]);
  });

  it("self-dependency is a cycle of one", () => {
    const err = caught(() => resolveOrder([p("a", { a: "*" })]));
    expect(err.code).toBe("DEPENDENCY_CYCLE");
    expect(err.pluginIds).toEqual(["a"]);
  });

  it("self-contained duplicate plugin ids throw MANIFEST_INVALID", () => {
    const err = caught(() => resolveOrder([p("a"), p("b"), p("a")]));
    expect(err.code).toBe("MANIFEST_INVALID");
    expect(err.pluginIds).toEqual(["a"]);
    expect(err.details).toEqual({ problems: [{ plugin: "a", dependency: "a" }] });
  });

  it("plugins without dependency records resolve", () => {
    expect(ids(resolveOrder([{ id: "a", version: "1.0.0" }]).order)).toEqual(["a"]);
  });
});

describe("dependentsOf", () => {
  it("returns transitive closure including optional edges", () => {
    const plugins = [p("a"), p("b", { a: "*" }), p("c", {}, { b: "*" }), p("d"), p("e", { d: "*" })];
    expect([...dependentsOf(["a"], plugins)].sort()).toEqual(["a", "b", "c"]);
    expect([...dependentsOf(["d", "c"], plugins)].sort()).toEqual(["c", "d", "e"]);
  });

  it("includes the ids themselves and tolerates cycles and unknown ids", () => {
    const plugins = [p("a", { b: "*" }), p("b", { a: "*" })];
    expect([...dependentsOf(["a", "nope"], plugins)].sort()).toEqual(["a", "b", "nope"]);
  });
});
