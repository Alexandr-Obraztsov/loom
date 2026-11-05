import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { buildTree } from "../../src/core/tree.js";
import type { ResolvedNode } from "../../src/core/types.js";
import type { Ctx } from "./tree-helpers.js";
import { at, e, ext, slot, use } from "./tree-helpers.js";

describe("buildTree input rules", () => {
  it("multiple:false input with several children gives EXTENSION_CONFLICT on the parent", () => {
    const factory = vi.fn(() => 1);
    const entries = [
      e("p", ext("app", { inputs: { one: {} }, factory })),
      e("a", ext("x", { attachTo: at("app", "one") })),
      e("b", ext("y", { attachTo: at("app", "one") })),
    ];
    const r = buildTree(entries, {}, { use });
    expect(r.root?.errors[0]?.code).toBe("EXTENSION_CONFLICT");
    expect(r.root?.errors[0]?.pluginIds).toEqual(expect.arrayContaining(["p", "a", "b"]));
    expect(r.root?.errors[0]?.message).toContain("x");
    expect(r.root?.errors[0]?.message).toContain("y");
    expect(r.root?.value).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
    expect((r.root?.inputs["one"] as ResolvedNode[]).map((n) => n.id)).toEqual(["x", "y"]);
  });

  it("required input with no healthy child errors the parent", () => {
    const entries = [e("p", ext("app", { inputs: { one: { required: true } } }))];
    const r = buildTree(entries, {}, { use });
    expect(r.root?.errors[0]?.code).toBe("EXTENSION_INPUT_MISMATCH");
    expect(r.root?.errors[0]?.pluginIds).toEqual(["p"]);
    expect(r.root?.value).toBeUndefined();
  });

  it("required multiple input with only an errored child errors the parent", () => {
    const entries = [
      e("p", ext("app", { inputs: { s: { multiple: true, required: true, schema: z.number() } } })),
      e("q", ext("bad", { attachTo: at("app", "s") })),
    ];
    expect(buildTree(entries, {}, { use }).root?.errors[0]?.code).toBe("EXTENSION_INPUT_MISMATCH");
  });

  it("schema failure marks the child EXTENSION_INPUT_MISMATCH and excludes it from the factory inputs but not from node.inputs", () => {
    let seen: ResolvedNode[] = [];
    const entries = [
      e("p", ext("app", { inputs: { s: { multiple: true, schema: z.number() } }, factory: (c) => { seen = c.inputs["s"] as ResolvedNode[]; return 0; } })),
      e("q", ext("good", { attachTo: at("app", "s"), factory: () => 5 })),
      e("q", ext("bad", { attachTo: at("app", "s"), order: 1, factory: () => "str" })),
    ];
    const r = buildTree(entries, {}, { use });
    expect(seen.map((n) => n.id)).toEqual(["good"]);
    const all = r.root?.inputs["s"] as ResolvedNode[];
    expect(all.map((n) => n.id)).toEqual(["good", "bad"]);
    const bad = all[1];
    expect(bad?.errors[0]?.code).toBe("EXTENSION_INPUT_MISMATCH");
    expect(bad?.errors[0]?.pluginIds).toEqual(["q", "p"]);
    expect(Array.isArray(bad?.errors[0]?.details)).toBe(true);
    expect(bad?.value).toBeUndefined();
    expect(r.errors).toEqual(bad?.errors);
  });

  it("errored single child is not passed to the factory", () => {
    let seen: Ctx | undefined;
    const entries = [
      e("p", ext("app", { inputs: { one: { schema: z.number() } }, factory: (c) => { seen = c; return 1; } })),
      e("q", ext("c", { attachTo: at("app", "one") })),
    ];
    const r = buildTree(entries, {}, { use });
    expect(seen?.inputs["one"]).toBeUndefined();
    expect((r.root?.inputs["one"] as ResolvedNode).errors[0]?.code).toBe("EXTENSION_INPUT_MISMATCH");
  });
});

describe("buildTree failures", () => {
  it("throwing factory gives EXTENSION_FACTORY_FAILED and leaves siblings and parent intact", () => {
    const boom = new Error("boom");
    let parentSaw: ResolvedNode[] = [];
    const entries = [
      e("p", ext("app", { inputs: slot, factory: (c) => { parentSaw = c.inputs["slot"] as ResolvedNode[]; return "parent"; } })),
      e("q", ext("ok1", { attachTo: at("app", "slot"), order: 0 })),
      e("q", ext("bad", { attachTo: at("app", "slot"), order: 1, factory: () => { throw boom; } })),
      e("q", ext("ok2", { attachTo: at("app", "slot"), order: 2 })),
    ];
    const r = buildTree(entries, {}, { use });
    expect(r.root?.value).toBe("parent");
    expect(r.root?.errors).toEqual([]);
    const kids = r.root?.inputs["slot"] as ResolvedNode[];
    expect(kids.map((n) => n.value)).toEqual(["ok1", undefined, "ok2"]);
    expect(kids[1]?.errors[0]?.code).toBe("EXTENSION_FACTORY_FAILED");
    expect(kids[1]?.errors[0]?.cause).toBe(boom);
    expect(kids[1]?.errors[0]?.pluginIds).toEqual(["q"]);
    expect(parentSaw.map((n) => n.id)).toEqual(["ok1", "ok2"]);
    expect(r.errors).toEqual(kids[1]?.errors);
  });

  it("errors are listed in tree order, node errors before child errors, then orphans", () => {
    const entries = [
      e("p", ext("app", { inputs: { s: { multiple: true }, one: {} }, factory: () => 1 })),
      e("q", ext("c1", { attachTo: at("app", "s"), factory: () => { throw new Error("x"); } })),
      e("q", ext("c2", { attachTo: at("app", "one") })),
      e("q", ext("c3", { attachTo: at("app", "one") })),
      e("q", ext("orph", { attachTo: at("zz", "s") })),
    ];
    const r = buildTree(entries, {}, { use });
    expect(r.errors.map((x) => x.code)).toEqual([
      "EXTENSION_CONFLICT",
      "EXTENSION_FACTORY_FAILED",
      "EXTENSION_INPUT_MISMATCH",
    ]);
  });
});
