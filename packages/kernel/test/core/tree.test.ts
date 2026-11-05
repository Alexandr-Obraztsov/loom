import { describe, expect, it } from "vitest";

import { buildTree } from "../../src/core/tree.js";
import type { ResolvedNode } from "../../src/core/types.js";
import type { Ctx } from "./tree-helpers.js";
import { at, childIds, e, ext, slot, use } from "./tree-helpers.js";

describe("buildTree basics", () => {
  it("uses 'app' as default root and a custom rootId when configured", () => {
    const entries = [e("p", ext("app")), e("p", ext("main"))];
    expect(buildTree(entries, {}, { use }).root?.id).toBe("app");
    const custom = buildTree(entries, { rootId: "main" }, { use });
    expect(custom.root?.id).toBe("main");
    expect(custom.orphans.map((o) => o.id)).toEqual(["app"]);
  });

  it("returns an undefined root when the root extension is missing", () => {
    const r = buildTree([e("p", ext("x", { attachTo: at("app", "slot") }))], {}, { use });
    expect(r.root).toBeUndefined();
    expect(r.orphans[0]?.reason.code).toBe("EXTENSION_INPUT_MISMATCH");
  });

  it("factory receives resolved inputs: array for multiple (maybe empty), node or undefined for single", () => {
    let seen: Ctx | undefined;
    const entries = [
      e("p", ext("app", { inputs: { list: { multiple: true }, none: { multiple: true }, one: {}, nothing: {} }, factory: (c) => { seen = c; return 1; } })),
      e("p", ext("a", { attachTo: at("app", "list") })),
      e("p", ext("b", { attachTo: at("app", "list") })),
      e("p", ext("c", { attachTo: at("app", "one") })),
    ];
    const r = buildTree(entries, {}, { use });
    expect(r.root?.value).toBe(1);
    expect((seen?.inputs["list"] as ResolvedNode[]).map((n) => n.value)).toEqual(["a", "b"]);
    expect(seen?.inputs["none"]).toEqual([]);
    expect((seen?.inputs["one"] as ResolvedNode).value).toBe("c");
    expect(seen?.inputs["nothing"]).toBeUndefined();
    expect(seen?.config).toBeUndefined();
    expect(() => seen?.use({ id: "x", kind: "service" })).toThrow("unused");
  });

  it("orders children by order asc then id", () => {
    const entries = [
      e("p", ext("app", { inputs: slot })),
      e("p", ext("z", { attachTo: at("app", "slot"), order: 1 })),
      e("p", ext("b", { attachTo: at("app", "slot"), order: 2 })),
      e("p", ext("a", { attachTo: at("app", "slot"), order: 2 })),
      e("p", ext("m", { attachTo: at("app", "slot"), order: -1 })),
      e("p", ext("n", { attachTo: at("app", "slot") })),
    ];
    expect(childIds(buildTree(entries, {}, { use }).root, "slot")).toEqual(["m", "n", "z", "a", "b"]);
  });
});

describe("buildTree placement", () => {
  it("attach config replaces attachTo", () => {
    const entries = [
      e("p", ext("app", { inputs: { one: { multiple: true }, two: { multiple: true } } })),
      e("p", ext("a", { attachTo: at("app", "one") })),
    ];
    const r = buildTree(entries, { attach: { a: at("app", "two") } }, { use });
    expect(childIds(r.root, "one")).toEqual([]);
    expect(childIds(r.root, "two")).toEqual(["a"]);
  });

  it("attach config can place an extension that has no attachTo", () => {
    const entries = [e("p", ext("app", { inputs: slot })), e("p", ext("a"))];
    expect(childIds(buildTree(entries, { attach: { a: at("app", "slot") } }, { use }).root, "slot")).toEqual(["a"]);
  });

  it("extension without attachTo and not root is an orphan", () => {
    const r = buildTree([e("p", ext("app")), e("q", ext("lonely"))], {}, { use });
    expect(r.orphans).toHaveLength(1);
    expect(r.orphans[0]).toMatchObject({ id: "lonely", pluginId: "q" });
    expect(r.orphans[0]?.reason.code).toBe("EXTENSION_INPUT_MISMATCH");
  });

  it("missing parent and unknown input make orphans with reasons", () => {
    const entries = [
      e("p", ext("app", { inputs: slot })),
      e("q", ext("ghost", { attachTo: at("nope", "slot") })),
      e("q", ext("badinput", { attachTo: at("app", "other") })),
      e("q", ext("noinputs", { attachTo: at("ghost", "x") })),
    ];
    const r = buildTree(entries, {}, { use });
    expect(r.orphans.map((o) => o.id)).toEqual(["badinput", "ghost", "noinputs"]);
    for (const o of r.orphans) {
      expect(o.reason.code).toBe("EXTENSION_INPUT_MISMATCH");
    }
    expect(r.orphans[0]?.reason.message).toContain("other");
    expect(r.orphans[1]?.reason.message).toContain("nope");
    expect(r.errors).toEqual(r.orphans.map((o) => o.reason));
  });

  it("disabled removes the node and its subtree; descendants become orphans, disabled itself does not", () => {
    const entries = [
      e("p", ext("app", { inputs: slot })),
      e("p", ext("mid", { attachTo: at("app", "slot"), inputs: slot })),
      e("p", ext("leaf", { attachTo: at("mid", "slot"), inputs: slot })),
      e("p", ext("deep", { attachTo: at("leaf", "slot") })),
    ];
    const r = buildTree(entries, { disabled: ["mid"] }, { use });
    expect(childIds(r.root, "slot")).toEqual([]);
    expect(r.orphans.map((o) => o.id)).toEqual(["deep", "leaf"]);
    expect(r.orphans.find((o) => o.id === "leaf")?.reason.message).toContain("disabled");
    expect(r.orphans.find((o) => o.id === "deep")?.reason.message).toContain("leaf");
  });

  it("disabled root yields no tree", () => {
    const r = buildTree([e("p", ext("app"))], { disabled: ["app"] }, { use });
    expect(r.root).toBeUndefined();
    expect(r.orphans).toEqual([]);
  });
});
