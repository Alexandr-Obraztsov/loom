import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildTree } from "../../src/core/tree.js";
import type { TreeResult } from "../../src/core/tree.js";
import type { ExtensionDefinition, ResolvedNode } from "../../src/core/types.js";
import type { Entry } from "./tree-helpers.js";
import { at, childIds, e, ext, slot, use } from "./tree-helpers.js";

function make(spies: Record<string, ReturnType<typeof vi.fn>>): { defs: Record<string, ExtensionDefinition>; entries: () => Entry[] } {
  const mk = (id: string, rest: Partial<ExtensionDefinition>): ExtensionDefinition => {
    const spy = vi.fn(() => id);
    spies[id] = spy;
    return ext(id, { ...rest, factory: spy });
  };
  const defs = {
    app: mk("app", { inputs: { ...slot, alt: { multiple: true } } }),
    left: mk("left", { attachTo: at("app", "slot"), inputs: slot, order: 0 }),
    leaf: mk("leaf", { attachTo: at("left", "slot") }),
    right: mk("right", { attachTo: at("app", "slot"), order: 1 }),
  };
  return { defs, entries: () => Object.values(defs).map((d) => e("p", d)) };
}

describe("buildTree structural sharing", () => {

  it("unchanged build reuses previous node objects, skips factories and returns the previous result", () => {
    const spies: Record<string, ReturnType<typeof vi.fn>> = {};
    const { entries } = make(spies);
    const first = buildTree(entries(), {}, use);
    for (const s of Object.values(spies)) s.mockClear();
    const second = buildTree(entries(), {}, use, first);
    expect(second).toBe(first);
    expect(second.root).toBe(first.root);
    for (const s of Object.values(spies)) expect(s).not.toHaveBeenCalled();
  });

  it("changing one leaf re-creates only its ancestors", () => {
    const spies: Record<string, ReturnType<typeof vi.fn>> = {};
    const { defs, entries } = make(spies);
    const first = buildTree(entries(), {}, use);
    for (const s of Object.values(spies)) s.mockClear();
    const newLeaf = ext("leaf", { attachTo: at("left", "slot") });
    const list = entries().map((x) => (x.ext.id === "leaf" ? e("p", newLeaf) : x));
    const second = buildTree(list, {}, use, first);
    expect(second).not.toBe(first);
    const [l1, r1] = first.root?.inputs["slot"] as ResolvedNode[] as [ResolvedNode, ResolvedNode];
    const [l2, r2] = second.root?.inputs["slot"] as ResolvedNode[] as [ResolvedNode, ResolvedNode];
    expect(second.root).not.toBe(first.root);
    expect(l2).not.toBe(l1);
    expect(l2.inputs["slot"]).not.toBe(l1.inputs["slot"]);
    expect(r2).toBe(r1);
    expect(spies["app"]).toHaveBeenCalledTimes(1);
    expect(spies["left"]).toHaveBeenCalledTimes(1);
    expect(spies["right"]).not.toHaveBeenCalled();
    expect(defs["leaf"]).not.toBe(newLeaf);
  });

  it("a changed attach config re-creates the node and its ancestors only", () => {
    const spies: Record<string, ReturnType<typeof vi.fn>> = {};
    const { entries } = make(spies);
    const first = buildTree(entries(), {}, use);
    for (const s of Object.values(spies)) s.mockClear();
    const second = buildTree(entries(), { attach: { right: at("app", "alt") } }, use, first);
    expect(second.root).not.toBe(first.root);
    expect(spies["right"]).toHaveBeenCalledTimes(1);
    expect(spies["left"]).not.toHaveBeenCalled();
  });

  it("a change of winners or disabled invalidates reuse of affected nodes", () => {
    const spies: Record<string, ReturnType<typeof vi.fn>> = {};
    const { entries } = make(spies);
    const first = buildTree(entries(), {}, use);
    const second = buildTree(entries(), { disabled: ["right"] }, use, first);
    expect(childIds(second.root, "slot")).toEqual(["left"]);
    expect(second.orphans).toEqual([]);
  });
});

describe("buildTree sharing edge cases", () => {
  it("orphan-only changes produce a new result with the same root", () => {
    const spies: Record<string, ReturnType<typeof vi.fn>> = {};
    const { entries } = make(spies);
    const first = buildTree(entries(), {}, use);
    const second = buildTree([...entries(), e("p", ext("lost", { attachTo: at("nope", "x") }))], {}, use, first);
    expect(second).not.toBe(first);
    expect(second.root).toBe(first.root);
    expect(second.orphans.map((o) => o.id)).toEqual(["lost"]);
  });

  it("a replaced orphan of the same count still yields a new result", () => {
    const spies: Record<string, ReturnType<typeof vi.fn>> = {};
    const { entries } = make(spies);
    const first = buildTree([...entries(), e("p", ext("x", { attachTo: at("nope", "x") }))], {}, use);
    const second = buildTree([...entries(), e("p", ext("y", { attachTo: at("nope", "x") }))], {}, use, first);
    expect(second).not.toBe(first);
    expect(second.orphans.map((o) => o.id)).toEqual(["y"]);
  });

  it("ignores a previous result that was not produced by buildTree", () => {
    const fake: TreeResult = { root: { id: "app", pluginId: "p", value: 1, inputs: {} }, orphans: [], errors: [] };
    const r = buildTree([e("p", ext("app"))], {}, use, fake);
    expect(r.root?.value).toBe("app");
    expect(r).not.toBe(fake);
  });

  it("a changed child schema invalidates reuse of that child", () => {
    const leafDef = ext("leaf", { attachTo: at("app", "s"), factory: () => 1 });
    const mkApp = (schema: z.ZodType): Entry[] => [e("p", ext("app", { inputs: { s: { schema } } })), e("p", leafDef)];
    const first = buildTree(mkApp(z.number()), {}, use);
    const second = buildTree(mkApp(z.string()), {}, use, first);
    expect((first.root?.inputs["s"] as ResolvedNode).error).toBeUndefined();
    expect((second.root?.inputs["s"] as ResolvedNode).error?.code).toBe("EXTENSION_INPUT_MISMATCH");
  });
});
