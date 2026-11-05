import { describe, expect, it } from "vitest";

import { attach, createExtension, createHook, createServiceRef, definePlugin } from "../../src/core/definitions.js";
import { LoomError } from "../../src/core/errors.js";
import type { ManifestIssue } from "../../src/core/manifest.js";
import { validatePlugin } from "../../src/core/manifest.js";

function issuesOf(def: unknown): readonly ManifestIssue[] {
  try {
    validatePlugin(def);
  } catch (e) {
    expect(e).toBeInstanceOf(LoomError);
    const err = e as LoomError;
    expect(err.code).toBe("MANIFEST_INVALID");
    return (err.details as { issues: ManifestIssue[] }).issues;
  }
  throw new Error("expected validatePlugin to throw");
}

const ext = (id: string): { id: string; factory: () => number } => ({ id, factory: () => 1 });

describe("validatePlugin", () => {
  it("rejects unknown keys on plugins and extensions, naming the key", () => {
    const top = JSON.stringify(issuesOf({ id: "a", version: "1.0.0", dependOn: { b: "^1.0.0" } }));
    expect(top).toContain("dependOn");
    const nested = JSON.stringify(issuesOf({ id: "a", version: "1.0.0", extensions: [{ ...ext("e"), atachTo: {} }] }));
    expect(nested).toContain("atachTo");
  });

  it("accepts a minimal plugin {id, version}", () => {
    expect(validatePlugin({ id: "a", version: "1.0.0" }).id).toBe("a");
  });

  it("accepts scoped ids, ranges, startup, setup, extensions and overrides", () => {
    const def = definePlugin({
      id: "acme/jira",
      version: "1.2.3",
      dependsOn: { b: "^1.0.0" },
      optionalDependsOn: { c: ">=2" },
      startup: { x: 1 },
      setup: () => undefined,
      extensions: [createExtension({ id: "e1", attachTo: { id: "p", input: "i" }, inputs: { k: { multiple: true, required: false } }, order: 1, factory: () => 1 })],
      overrides: [ext("e1")],
    });
    expect(validatePlugin(def)).toBe(def);
  });

  it.each(["A", "1a", "a_b", "a/b/c", "", "a/"])("rejects id %j", (id) => {
    expect(issuesOf({ id, version: "1.0.0" }).length).toBeGreaterThan(0);
  });

  it("rejects non-semver version", () => {
    expect(issuesOf({ id: "a", version: "1.0" }).length).toBe(1);
  });

  it("rejects invalid range in dependsOn", () => {
    expect(issuesOf({ id: "a", version: "1.0.0", dependsOn: { b: "not a range" } }).length).toBe(1);
    expect(issuesOf({ id: "a", version: "1.0.0", optionalDependsOn: { b: "!!" } }).length).toBe(1);
  });

  it("rejects plugin listing itself as dependency", () => {
    expect(issuesOf({ id: "a", version: "1.0.0", dependsOn: { a: "*" } }).length).toBe(1);
    expect(issuesOf({ id: "a", version: "1.0.0", optionalDependsOn: { a: "*" } }).length).toBe(1);
  });

  it("rejects same id in dependsOn and optionalDependsOn", () => {
    expect(issuesOf({ id: "a", version: "1.0.0", dependsOn: { b: "*" }, optionalDependsOn: { b: "*" } }).length).toBe(1);
  });

  it("rejects duplicate extension ids inside one plugin", () => {
    expect(issuesOf({ id: "a", version: "1.0.0", extensions: [ext("x"), ext("x")] }).length).toBe(1);
  });

  it("rejects duplicate override ids but allows an override reusing an extension id", () => {
    expect(issuesOf({ id: "a", version: "1.0.0", overrides: [ext("x"), ext("x")] }).length).toBe(1);
    expect(() => validatePlugin({ id: "a", version: "1.0.0", extensions: [ext("x")], overrides: [ext("x")] })).not.toThrow();
  });

  it("error lists all issues, not only the first", () => {
    const issues = issuesOf({ id: "A", version: "nope", dependsOn: { b: "!!" } });
    expect(issues.length).toBe(3);
  });

  it("rejects non-object input and wrong field types", () => {
    expect(issuesOf(null).length).toBeGreaterThan(0);
    expect(issuesOf({ id: "a", version: "1.0.0", setup: "x", scope: "user" }).length).toBe(2);
  });

  it("handles prototype-named keys without false positives", () => {
    expect(() => validatePlugin({ id: "constructor", version: "1.0.0", dependsOn: { b: "*" } })).not.toThrow();
    expect(() => validatePlugin({ id: "a", version: "1.0.0", dependsOn: { toString: "*" }, optionalDependsOn: { b: "*" } })).not.toThrow();
    expect(() => validatePlugin({ id: "a", version: "1.0.0", dependsOn: { b: "*" }, optionalDependsOn: { constructor: "*" } })).not.toThrow();
    expect(issuesOf({ id: "a", version: "1.0.0", dependsOn: { toString: "*" }, optionalDependsOn: { toString: "*" } }).length).toBe(1);
  });

  it("validates extension structure", () => {
    expect(issuesOf({ id: "a", version: "1.0.0", extensions: [{ id: 1, factory: 2 }] }).length).toBe(2);
    expect(issuesOf({ id: "a", version: "1.0.0", extensions: [{ id: "x", factory: () => 1, attachTo: { id: "p" } }] }).length).toBe(1);
    expect(issuesOf({ id: "a", version: "1.0.0", extensions: [{ id: "x", factory: () => 1, inputs: { k: 5 } }] }).length).toBe(1);
    expect(issuesOf({ id: "a", version: "1.0.0", overrides: [{ id: "x" }] }).length).toBe(1);
    expect(issuesOf({ id: "a", version: "1.0.0", extensions: [{ id: "x", factory: () => 1, inputs: { k: { schema: 5 } } }] }).length).toBe(1);
  });
});

describe("constructors", () => {
  it("createServiceRef and createHook build refs", () => {
    expect(createServiceRef<{ a: 1 }>("svc")).toEqual({ id: "svc", kind: "service" });
    expect(createHook<number, Promise<number>>("h")).toEqual({ id: "h", kind: "hook", mode: "async" });
    expect(createHook<number, number>("h", { mode: "sync" }).mode).toBe("sync");
  });
});

describe("attach", () => {
  it("builds id parent/input/value.id", () => {
    const e = attach("parent", "items", { id: "v", label: "x" }, { order: 5 });
    expect(e.id).toBe("parent/items/v");
    expect(e.attachTo).toEqual({ id: "parent", input: "items" });
    expect(e.order).toBe(5);
    expect(e.factory({ inputs: {}, use: () => undefined as never, config: undefined })).toEqual({ id: "v", label: "x" });
  });

  it("without value.id gives the same id for structurally equal values", () => {
    const fn = function run(): number { return 1; };
    const a = attach("p", "i", { b: 1, a: [1, { z: 1, y: 2 }], fn });
    const b = attach("p", "i", { fn, a: [1, { y: 2, z: 1 }], b: 1 });
    const c = attach("p", "i", { b: 2, a: [1], fn });
    expect(a.id).toBe(b.id);
    expect(a.id).not.toBe(c.id);
    expect(a.id).toMatch(/^p\/i\/[0-9a-f]{8}$/);
    expect(a.order).toBeUndefined();
  });

  it("with a cyclic id-less value returns a stable id and does not throw", () => {
    const make = (): object => {
      const o: { n: number; self?: unknown } = { n: 1 };
      o.self = o;
      return o;
    };
    expect(attach("p", "i", make()).id).toBe(attach("p", "i", make()).id);
  });

  it("distinguishes BigInt, NaN, Infinity, Dates, Maps and Sets", () => {
    const id = (v: unknown): string => attach("p", "i", v as object).id;
    expect(id(1n)).not.toBe(id(2n));
    expect(id(Number.NaN)).not.toBe(id(null));
    expect(id(Infinity)).not.toBe(id(-Infinity));
    expect(id(Infinity)).not.toBe(id(null));
    expect(id(new Date(1000))).toBe(id(new Date(1000)));
    expect(id(new Date(1000))).not.toBe(id(new Date(2000)));
    expect(id(new Date(Number.NaN))).toBe(id(new Date(Number.NaN)));
    expect(id(new Map([["a", 1], ["b", 2]]))).toBe(id(new Map([["b", 2], ["a", 1]])));
    expect(id(new Map([["a", 1]]))).not.toBe(id(new Map([["a", 2]])));
    expect(id(new Set([1, 2]))).toBe(id(new Set([2, 1])));
    expect(id(new Set([1]))).not.toBe(id([1]));
    expect(id(Symbol("s"))).not.toBe(id(Symbol("s")));
  });

  it("gives the same id to shared (non-cyclic) references", () => {
    const shared = { a: 1 };
    const id = (v: unknown): string => attach("p", "i", v as object).id;
    expect(id({ x: shared, y: shared })).toBe(id({ x: { a: 1 }, y: { a: 1 } }));
  });

  it("values differing only in function body get the same id", () => {
    const id = (v: unknown): string => attach("p", "i", v as object).id;
    expect(id({ run: function go() { return 1; } })).toBe(id({ run: function go() { return 2; } }));
  });

  it("hashes primitives, null and function-name differences", () => {
    const id = (v: unknown): string => attach("p", "i", v as object).id;
    expect(id("s")).not.toBe(id("t"));
    expect(id(null)).not.toBe(id(undefined));
    expect(id({ a: undefined, b: "é" })).toBe(id({ b: "é" }));
    expect(id({ b: "é" })).not.toBe(id({ b: "e" }));
    expect(id(() => 1)).toBe(id(() => 2));
    expect(id({ f() { return 1; } })).not.toBe(id({ g() { return 1; } }));
  });
});

describe("validatePlugin strictness", () => {
  it("names the offending field as a path array, one issue per unknown key", () => {
    expect(issuesOf({ id: "a", version: "1.0.0", dependOn: {} })).toEqual([
      { path: ["dependOn"], message: "unknown key \"dependOn\"" },
    ]);
    const nested = issuesOf({ id: "a", version: "1.0.0", extensions: [{ ...ext("e"), atachTo: {}, orderr: 1 }] });
    expect(nested.map((i) => i.path)).toEqual([
      ["extensions", 0, "atachTo"],
      ["extensions", 0, "orderr"],
    ]);
  });

  it("accepts build metadata and prereleases in the version", () => {
    for (const version of ["1.0.0+build.5", "1.0.0-beta.1+sha.abc"]) {
      expect(() => validatePlugin({ id: "a", version }), version).not.toThrow();
    }
  });

  it("rejects a v-prefixed version and an empty dependency range", () => {
    for (const version of ["v1.0.0", "=1.0.0", " 1.0.0"]) expect(issuesOf({ id: "a", version })).toHaveLength(1);
    expect(issuesOf({ id: "a", version: "1.0.0", dependsOn: { b: "" } })).toHaveLength(1);
    expect(issuesOf({ id: "a", version: "1.0.0", optionalDependsOn: { b: "" } })).toHaveLength(1);
  });
});

describe("attach hashing details", () => {
  const id = (v: unknown): string => attach("p", "i", v as object).id;

  it("hashes -0 and 0 differently", () => {
    expect(id({ n: -0 })).not.toBe(id({ n: 0 }));
  });

  it("hashes distinct symbols with one description differently, one symbol stably", () => {
    const s = Symbol("s");
    expect(id({ k: s })).toBe(id({ k: s }));
    expect(id({ k: Symbol("s") })).not.toBe(id({ k: Symbol("s") }));
    expect(id({ k: Symbol.for("s") })).toBe(id({ k: Symbol.for("s") }));
    expect(id({ k: Symbol.for("s") })).not.toBe(id({ k: Symbol("s") }));
  });

  it("hashes instances of different classes with equal fields differently", () => {
    class A { x = 1; }
    class B { x = 1; }
    expect(id(new A())).toBe(id(new A()));
    expect(id(new A())).not.toBe(id(new B()));
    expect(id(new A())).not.toBe(id({ x: 1 }));
  });
});

describe("definePlugin freezes the definition structure", () => {
  const build = (): ReturnType<typeof definePlugin> =>
    definePlugin({
      id: "p",
      version: "1.0.0",
      dependsOn: { a: "1" },
      optionalDependsOn: { b: "1" },
      extensions: [{ id: "e", factory: () => 1, inputs: { slot: { config: {} } }, defaults: { foo: 0 } } as never],
      overrides: [{ id: "o", factory: () => 1 }],
    });

  it("rejects mutation of the object, dependency maps, extension lists and extension definitions", () => {
    const def = build();
    expect(() => {
      (def.extensions as unknown[]).push({});
    }).toThrow(TypeError);
    expect(() => {
      (def.dependsOn as Record<string, string>).x = "1";
    }).toThrow(TypeError);
    expect(() => {
      (def.optionalDependsOn as Record<string, string>).x = "1";
    }).toThrow(TypeError);
    expect(() => {
      (def.overrides as unknown[]).push({});
    }).toThrow(TypeError);
    expect(() => {
      def.version = "2.0.0";
    }).toThrow(TypeError);
    expect(() => {
      (def.extensions?.[0] as { id: string }).id = "z";
    }).toThrow(TypeError);
  });

  it("leaves the plugin's own data inside the definition mutable", () => {
    const def = build();
    const ext = def.extensions?.[0] as unknown as { defaults: Record<string, number>; inputs: Record<string, { config: object }> };
    expect(() => {
      ext.defaults.foo = 1;
    }).not.toThrow();
    expect(() => {
      Object.assign(ext.inputs.slot?.config ?? {}, { k: 1 });
    }).not.toThrow();
  });

  it("accepts a definition with no optional parts", () => {
    expect(Object.isFrozen(definePlugin({ id: "p", version: "1.0.0" }))).toBe(true);
  });
});
