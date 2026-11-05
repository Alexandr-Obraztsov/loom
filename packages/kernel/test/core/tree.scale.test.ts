import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { buildTree } from "../../src/core/tree.js";
import type { ResolvedNode } from "../../src/core/types.js";
import type { Entry } from "./tree-helpers.js";
import { at, e, ext, slot, use } from "./tree-helpers.js";

/** `n` extensions in a line: app <- e1 <- e2 <- ... ; `rootId` of the line is "app". */
function line(n: number, pluginOf: (k: number) => string = () => "p"): Entry[] {
  return Array.from({ length: n }, (_, k) =>
    e(pluginOf(k), ext(k === 0 ? "app" : `e${String(k)}`, { inputs: slot, ...(k === 0 ? {} : { attachTo: at(k === 1 ? "app" : `e${String(k - 1)}`, "slot") }) })),
  );
}

describe("buildTree depth", () => {
  it("builds a chain 10 000 deep without a RangeError and lists no errors", () => {
    const r = buildTree(line(10_000), {}, { use });
    expect(r.errors).toEqual([]);
    let depth = 0;
    for (let n = r.root; n; n = (n.inputs["slot"] as ResolvedNode[])[0]) depth++;
    expect(depth).toBe(10_000);
  });

  it("collects the errors of a 10 000 deep chain without recursion, in tree order", () => {
    const entries = line(10_000);
    entries[9_999] = e("p", ext("e9999", { attachTo: at("e9998", "slot"), factory: () => { throw new Error("deep"); } }));
    const r = buildTree(entries, {}, { use });
    expect(r.errors.map((x) => x.code)).toEqual(["EXTENSION_FACTORY_FAILED"]);
  });

  it("calls factories children first, siblings in input order", () => {
    const calls: string[] = [];
    const f = (id: string) => (): string => { calls.push(id); return id; };
    const entries = [
      e("p", ext("app", { inputs: { a: { multiple: true }, b: { multiple: true } }, factory: f("app") })),
      e("p", ext("a1", { attachTo: at("app", "a"), inputs: slot, factory: f("a1"), order: 0 })),
      e("p", ext("a1x", { attachTo: at("a1", "slot"), factory: f("a1x") })),
      e("p", ext("a2", { attachTo: at("app", "a"), factory: f("a2"), order: 1 })),
      e("p", ext("b1", { attachTo: at("app", "b"), factory: f("b1") })),
    ];
    buildTree(entries, {}, { use });
    expect(calls).toEqual(["a1x", "a1", "a2", "b1", "app"]);
  });
});

describe("orphan reasons at scale", () => {
  it("a detached chain of 1000 gives one error per orphan, each chain walked once, in < 50 ms", () => {
    const entries = Array.from({ length: 1000 }, (_, k) =>
      e(`p${String(k % 5)}`, ext(`x${String(k)}`, { attachTo: at(k === 0 ? "ghost" : `x${String(k - 1)}`, "slot"), inputs: slot })),
    );
    const start = performance.now();
    const r = buildTree(entries, {}, { use });
    const ms = performance.now() - start;
    expect(r.orphans).toHaveLength(1000);
    expect(r.errors).toHaveLength(1000);
    expect(r.orphans.every((o) => o.reason.message.includes('ancestor "x0"') || o.id === "x0")).toBe(true);
    expect(ms, `took ${ms.toFixed(1)} ms`).toBeLessThan(50);
  });

  it("a chain hanging off a cycle shares one cycle description instead of a chain per orphan", () => {
    const ring = [
      e("p", ext("c0", { attachTo: at("c2", "slot"), inputs: slot })),
      e("q", ext("c1", { attachTo: at("c0", "slot"), inputs: slot })),
      e("p", ext("c2", { attachTo: at("c1", "slot"), inputs: slot })),
    ];
    const tail = Array.from({ length: 2000 }, (_, k) => e("r", ext(`t${String(k)}`, { attachTo: at(k === 0 ? "c0" : `t${String(k - 1)}`, "slot"), inputs: slot })));
    const r = buildTree([...ring, ...tail], {}, { use });
    expect(r.orphans).toHaveLength(2003);
    const chains = new Set(r.orphans.map((o) => (o.reason.details as { chain: string[] }).chain));
    expect(chains.size).toBe(1);
    expect([...chains][0]).toHaveLength(3);
    expect(r.orphans.every((o) => o.reason.code === "DEPENDENCY_CYCLE")).toBe(true);
    expect(r.orphans.find((o) => o.id === "t5")?.reason.pluginIds).toEqual(expect.arrayContaining(["r", "p", "q"]));
  });
});

describe("node errors", () => {
  it("keeps every error of a node: a conflict and an input overflow", () => {
    const entries = [
      e("a", ext("app", { inputs: { one: {} } })),
      e("b", ext("app", { inputs: { one: {} } })),
      e("p", ext("x", { attachTo: at("app", "one") })),
      e("p", ext("y", { attachTo: at("app", "one") })),
    ];
    const r = buildTree(entries, {}, { use });
    expect(r.root?.errors.map((x) => x.code)).toEqual(["EXTENSION_CONFLICT", "EXTENSION_CONFLICT"]);
    expect(r.root?.errors[0]?.message).toContain("provided by several plugins");
    expect(r.root?.errors[1]?.message).toContain('Input "one"');
    expect(r.errors).toEqual(r.root?.errors);
    expect(r.root?.value).toBeUndefined();
  });

  it("lists same-level errors in tree order, each node's own errors first", () => {
    const entries = [
      e("p", ext("app", { inputs: { s: { multiple: true } } })),
      e("p", ext("k1", { attachTo: at("app", "s"), inputs: { r: { required: true } }, order: 0 })),
      e("p", ext("k2", { attachTo: at("app", "s"), inputs: { r: { required: true } }, order: 1 })),
      e("p", ext("k1c", { attachTo: at("k1", "r"), factory: () => { throw new Error("x"); } })),
    ];
    const r = buildTree(entries, {}, { use });
    expect(r.errors.map((x) => [x.code, x.pluginIds])).toEqual([
      ["EXTENSION_INPUT_MISMATCH", ["p"]],
      ["EXTENSION_FACTORY_FAILED", ["p"]],
      ["EXTENSION_INPUT_MISMATCH", ["p"]],
    ]);
    expect(r.errors[0]?.message).toContain('"k1"');
    expect(r.errors[2]?.message).toContain('"k2"');
  });

  it("a healthy node has no errors", () => {
    expect(buildTree([e("p", ext("app"))], {}, { use }).root?.errors).toEqual([]);
  });
});

describe("reuse", () => {
  it("a stably failing factory keeps the identity of the root, and is still retried", () => {
    const boom = vi.fn(() => { throw new Error("boom"); });
    const defs = [
      ext("app", { inputs: slot }),
      ext("mid", { attachTo: at("app", "slot"), inputs: slot }),
      ext("bad", { attachTo: at("mid", "slot"), factory: boom }),
    ];
    const entries = (): Entry[] => defs.map((d) => e("p", d));
    const first = buildTree(entries(), {}, { use });
    const second = buildTree(entries(), {}, { use, previous: first });
    expect(boom).toHaveBeenCalledTimes(2);
    expect(second).toBe(first);
    expect(second.root).toBe(first.root);
  });

  it("a factory that fails differently yields a new root", () => {
    let msg = "one";
    const defs = [ext("app", { inputs: slot }), ext("bad", { attachTo: at("app", "slot"), factory: () => { throw new Error(msg); } })];
    const entries = (): Entry[] => defs.map((d) => e("p", d));
    const first = buildTree(entries(), {}, { use });
    msg = "two";
    expect(buildTree(entries(), {}, { use, previous: first }).root).not.toBe(first.root);
  });

  it("a factory that throws non-errors compares the thrown values by identity", () => {
    const sym = { not: "an error" };
    let thrown: unknown = sym;
    const defs = [ext("app", { inputs: slot }), ext("bad", { attachTo: at("app", "slot"), factory: () => { throw thrown; } })];
    const entries = (): Entry[] => defs.map((d) => e("p", d));
    const first = buildTree(entries(), {}, { use });
    expect(buildTree(entries(), {}, { use, previous: first }).root).toBe(first.root);
    thrown = { not: "an error" };
    expect(buildTree(entries(), {}, { use, previous: first }).root).not.toBe(first.root);
  });

});

describe("reuse after configuration changes", () => {
  it("a change of winners rebuilds the contested node with the new winner (identity checked)", () => {
    const defs = [
      e("p", ext("app", { inputs: slot })),
      e("p", ext("w", { attachTo: at("app", "slot"), factory: () => "orig" })),
      e("a", ext("w", { factory: () => "from-a" }), true),
      e("b", ext("w", { factory: () => "from-b" }), true),
    ];
    const entries = (): Entry[] => [...defs];
    const first = buildTree(entries(), { winners: { w: "a" } }, { use });
    const again = buildTree(entries(), { winners: { w: "a" } }, { use, previous: first });
    expect(again).toBe(first);
    const second = buildTree(entries(), { winners: { w: "b" } }, { use, previous: first });
    expect(second.root).not.toBe(first.root);
    const slotOf = (r: typeof first): ResolvedNode => (r.root?.inputs["slot"] as ResolvedNode[])[0] as ResolvedNode;
    expect(slotOf(first).value).toBe("from-a");
    expect(slotOf(second).value).toBe("from-b");
    expect(slotOf(second)).not.toBe(slotOf(first));
  });

  it("disabling a node drops it and rebuilds its parent but reuses the untouched sibling", () => {
    const defs = [ext("app", { inputs: slot }), ext("a", { attachTo: at("app", "slot"), order: 0 }), ext("b", { attachTo: at("app", "slot"), order: 1 })];
    const entries = (): Entry[] => defs.map((d) => e("p", d));
    const first = buildTree(entries(), {}, { use });
    const second = buildTree(entries(), { disabled: ["b"] }, { use, previous: first });
    const a1 = (first.root?.inputs["slot"] as ResolvedNode[])[0];
    const kids = second.root?.inputs["slot"] as ResolvedNode[];
    expect(second.root).not.toBe(first.root);
    expect(kids).toHaveLength(1);
    expect(kids[0]).toBe(a1);
  });

  it("services at unchanged versions keep every node", () => {
    const svc = { id: "svc", kind: "service" } as const;
    const factory = vi.fn();
    const defs = [ext("app", { inputs: slot }), ext("leaf", { attachTo: at("app", "slot"), factory: (c) => { c.use(svc); factory(); return 1; } })];
    const entries = (): Entry[] => defs.map((d) => e("p", d));
    const svcUse = ((r: { id: string }) => ({ id: r.id })) as unknown as typeof use;
    const first = buildTree(entries(), {}, { use: svcUse, serviceVersion: () => 3 });
    expect(buildTree(entries(), {}, { use: svcUse, previous: first, serviceVersion: () => 3 })).toBe(first);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("a reused schema-failed child names the current parent plugin", () => {
    const leaf = ext("leaf", { attachTo: at("app", "s"), factory: () => 1 });
    const parent = ext("app", { inputs: { s: { schema: z.string() } } });
    const first = buildTree([e("p", parent), e("q", leaf)], {}, { use });
    const second = buildTree([e("p", parent), e("o", ext("app", {}), true), e("q", leaf)], {}, { use, previous: first });
    const err = (r: typeof first): readonly string[] => (r.root?.inputs["s"] as ResolvedNode).errors[0]?.pluginIds ?? [];
    expect(err(first)).toEqual(["q", "p"]);
    expect(err(second)).toEqual(["q", "o"]);
  });
});
