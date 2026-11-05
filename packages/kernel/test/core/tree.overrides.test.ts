import { describe, expect, it, vi } from "vitest";

import { buildTree } from "../../src/core/tree.js";
import type { ResolvedNode } from "../../src/core/types.js";
import type { Entry } from "./tree-helpers.js";
import { at, childIds, e, ext, slot, use } from "./tree-helpers.js";

describe("buildTree overrides and conflicts", () => {
  const base = (): Entry[] => [
    e("p", ext("app", { inputs: slot })),
    e("p", ext("target", { attachTo: at("app", "slot"), order: 3, inputs: slot, factory: () => "orig" })),
  ];


  it("override replaces the original and inherits attachTo and inputs when not given", () => {
    const r = buildTree([...base(), e("o", ext("target", { factory: (c) => `over:${String((c.inputs["slot"] as ResolvedNode[]).length)}` }), true), e("p", ext("kid", { attachTo: at("target", "slot") }))], {}, { use });
    const node = (r.root?.inputs["slot"] as ResolvedNode[])[0];
    expect(node).toMatchObject({ id: "target", pluginId: "o", value: "over:1" });
  });

  it("override with its own attachTo moves the node", () => {
    const entries = [
      e("p", ext("app", { inputs: { a: {}, b: {} } })),
      e("p", ext("target", { attachTo: at("app", "a") })),
      e("o", ext("target", { attachTo: at("app", "b") }), true),
    ];
    const r = buildTree(entries, {}, { use });
    expect(r.root?.inputs["a"]).toBeUndefined();
    expect((r.root?.inputs["b"] as ResolvedNode).pluginId).toBe("o");
  });

  it("override for an unknown id acts as a normal extension", () => {
    const r = buildTree([e("p", ext("app", { inputs: slot })), e("o", ext("new", { attachTo: at("app", "slot") }), true)], {}, { use });
    expect(childIds(r.root, "slot")).toEqual(["new"]);
  });

  it("can override the root", () => {
    const r = buildTree([e("p", ext("app")), e("o", ext("app", { factory: () => "mine" }), true)], {}, { use });
    expect(r.root).toMatchObject({ pluginId: "o", value: "mine" });
  });

  it("two overrides without a winner give EXTENSION_CONFLICT naming both plugins; children still resolve", () => {
    const factory = vi.fn(() => 1);
    const entries = [
      ...base(),
      e("o1", ext("target", { factory }), true),
      e("o2", ext("target", { factory }), true),
      e("p", ext("kid", { attachTo: at("target", "slot") })),
    ];
    const r = buildTree(entries, {}, { use });
    const node = (r.root?.inputs["slot"] as ResolvedNode[])[0];
    expect(node?.errors[0]?.code).toBe("EXTENSION_CONFLICT");
    expect(node?.errors[0]?.pluginIds).toEqual(["o1", "o2"]);
    expect(node?.value).toBeUndefined();
    expect(childIds(node, "slot")).toEqual(["kid"]);
    expect(factory).not.toHaveBeenCalled();
    expect(r.errors).toEqual(node?.errors);
  });

  it("winners picks one of two overrides", () => {
    const entries = [...base(), e("o1", ext("target", { factory: () => "one" }), true), e("o2", ext("target", { factory: () => "two" }), true)];
    const r = buildTree(entries, { winners: { target: "o2" } }, { use });
    expect((r.root?.inputs["slot"] as ResolvedNode[])[0]).toMatchObject({ pluginId: "o2", value: "two" });
    expect(r.errors).toEqual([]);
  });

  it("two non-override extensions with one id conflict unless a winner is configured", () => {
    const entries = [e("p", ext("app", { inputs: slot })), e("a", ext("dup", { attachTo: at("app", "slot") })), e("b", ext("dup", { attachTo: at("app", "slot") }))];
    const conflict = buildTree(entries, {}, { use });
    expect((conflict.root?.inputs["slot"] as ResolvedNode[])[0]?.errors[0]?.pluginIds).toEqual(["a", "b"]);
    const won = buildTree(entries, { winners: { dup: "b" } }, { use });
    expect((won.root?.inputs["slot"] as ResolvedNode[])[0]).toMatchObject({ pluginId: "b", value: "dup" });
  });

  it("an override wins over several originals without conflict", () => {
    const entries = [e("p", ext("app", { inputs: slot })), e("a", ext("dup", { attachTo: at("app", "slot") })), e("b", ext("dup", { attachTo: at("app", "slot") })), e("o", ext("dup", { factory: () => "o" }), true)];
    const r = buildTree(entries, { winners: { dup: "b" } }, { use });
    expect((r.root?.inputs["slot"] as ResolvedNode[])[0]).toMatchObject({ pluginId: "o", value: "o" });
  });
});

describe("buildTree cycles", () => {
  it("cycle in attachTo produces orphans with DEPENDENCY_CYCLE instead of infinite recursion", () => {
    const entries = [
      e("p", ext("app")),
      e("p", ext("a", { attachTo: at("b", "slot"), inputs: slot })),
      e("q", ext("b", { attachTo: at("a", "slot"), inputs: slot })),
      e("q", ext("self", { attachTo: at("self", "slot"), inputs: slot })),
      e("q", ext("tail", { attachTo: at("a", "slot") })),
    ];
    const r = buildTree(entries, {}, { use });
    expect(r.orphans.map((o) => [o.id, o.reason.code])).toEqual([
      ["a", "DEPENDENCY_CYCLE"],
      ["b", "DEPENDENCY_CYCLE"],
      ["self", "DEPENDENCY_CYCLE"],
      ["tail", "DEPENDENCY_CYCLE"],
    ]);
    expect(r.orphans[0]?.reason.pluginIds).toEqual(expect.arrayContaining(["p", "q"]));
  });
});
