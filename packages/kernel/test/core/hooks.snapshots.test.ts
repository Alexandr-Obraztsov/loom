import { describe, expect, it } from "vitest";

import { createHook } from "../../src/core/definitions.js";
import type { LoomError } from "../../src/core/errors.js";
import { createHookRegistry } from "../../src/core/hooks.js";

const sync = createHook<string[], string[]>("snap.sync", { mode: "sync" });
const pass = (owner: string) => (l: string[], next: (c: string[]) => string[]) =>
  next([...l, owner]);

describe("taps() snapshots", () => {
  it("returns plain snapshots without internals; mutating them does not change the order", () => {
    const reg = createHookRegistry({ onError: () => undefined });
    reg.tap(sync, { owner: "a", priority: 1 }, pass("a"));
    reg.tap(sync, { owner: "b" }, pass("b"));
    const snap = reg.taps(sync) as { owner: string; priority: number }[];
    expect(snap.map((t) => ({ ...t }))).toEqual([
      { owner: "a", priority: 1 },
      { owner: "b", priority: 0 },
    ]);
    expect(Object.keys(snap[0] as object).sort()).toEqual(["owner", "priority"]);
    for (const t of snap) {
      try {
        (t as { owner: string }).owner = "x";
      } catch {
        // a frozen snapshot may refuse; either way the registry must not see the change
      }
    }
    snap.reverse();
    snap.length = 0;
    expect(reg.taps(sync).map((t) => t.owner)).toEqual(["a", "b"]);
    expect(reg.run(sync, [], (l) => l)).toEqual(["a", "b"]);
  });
});

describe("onError robustness", () => {
  it("a throwing onError loses neither later reports nor the run", () => {
    const seen: string[] = [];
    const reg = createHookRegistry({
      onError: (e) => {
        seen.push(e.pluginIds.join("+"));
        throw new Error("sink");
      },
    });
    const end = reg.defer();
    reg.tap(sync, { owner: "a", before: ["b"] }, pass("a"));
    reg.tap(sync, { owner: "b", before: ["a"] }, pass("b"));
    reg.tap(sync, { owner: "c", before: ["d"] }, pass("c"));
    reg.tap(sync, { owner: "d", before: ["c"] }, pass("d"));
    end();
    expect(seen).toHaveLength(2);
    expect(reg.run(sync, [], (l) => l)).toEqual(["a", "b", "c", "d"]);
  });

  it("a tap added from onError while the order is being refreshed is in the order", () => {
    const holder: { reg?: ReturnType<typeof createHookRegistry> } = {};
    let hasFired = false;
    const reg = (holder.reg = createHookRegistry({
      onError: () => {
        if (hasFired) return;
        hasFired = true;
        holder.reg?.tap(sync, { owner: "late", priority: -1 }, pass("late"));
      },
    }));
    reg.tap(sync, { owner: "a", before: ["b"] }, pass("a"));
    reg.tap(sync, { owner: "b", before: ["a"] }, pass("b"));
    expect(hasFired).toBe(true);
    expect(reg.taps(sync).map((t) => t.owner)).toEqual(["a", "b", "late"]);
    expect(reg.run(sync, [], (l) => l)).toEqual(["a", "b", "late"]);
  });
});

describe("contradiction reports across rank changes", () => {
  it("a contradiction is reported once per owner pair even when ranks flip which edge is dropped", () => {
    const ranks = new Map([
      ["a", 0],
      ["b", 1],
    ]);
    const errors: LoomError[] = [];
    const reg = createHookRegistry({
      onError: (e) => errors.push(e),
      rankOf: (o) => ranks.get(o) ?? 9,
    });
    reg.tap(sync, { owner: "a", before: ["b"] }, pass("a"));
    reg.tap(sync, { owner: "b", before: ["a"] }, pass("b"));
    expect(errors).toHaveLength(1);
    ranks.set("a", 1).set("b", 0);
    reg.reorder();
    expect(reg.taps(sync).map((t) => t.owner)).toEqual(["b", "a"]);
    expect(errors).toHaveLength(1);
  });

  it("is reported again after the contradiction is gone and returns", () => {
    const errors: LoomError[] = [];
    const reg = createHookRegistry({ onError: (e) => errors.push(e) });
    reg.tap(sync, { owner: "a", before: ["b"] }, pass("a"));
    reg.tap(sync, { owner: "b", before: ["a"] }, pass("b"));
    reg.removeOwner("b");
    reg.tap(sync, { owner: "b", before: ["a"] }, pass("b"));
    expect(errors).toHaveLength(2);
  });
});

describe("incremental insertion", () => {
  it("constraint-free taps added one by one with run in between keep priority, rank, registration order", () => {
    const ranks = new Map([
      ["x", 1],
      ["y", 0],
    ]);
    const reg = createHookRegistry({ onError: () => undefined, rankOf: (o) => ranks.get(o) ?? 5 });
    const seq: [string, number][] = [
      ["x", 0],
      ["y", 0],
      ["x", 2],
      ["z", 0],
      ["y", -1],
      ["x", 0],
    ];
    for (const [o, priority] of seq) {
      reg.tap(sync, { owner: o, priority }, pass(o));
      reg.run(sync, [], (l) => l);
    }
    expect(reg.run(sync, [], (l) => l)).toEqual(["x", "y", "x", "x", "z", "y"]);
  });

  it("a constrained tap among them falls back to a full recompute", () => {
    const reg = createHookRegistry({ onError: () => undefined });
    reg.tap(sync, { owner: "a" }, pass("a"));
    reg.run(sync, [], (l) => l);
    reg.tap(sync, { owner: "b", before: ["a"] }, pass("b"));
    reg.tap(sync, { owner: "c" }, pass("c"));
    expect(reg.run(sync, [], (l) => l)).toEqual(["b", "a", "c"]);
    reg.removeOwner("b");
    reg.tap(sync, { owner: "d" }, pass("d"));
    expect(reg.run(sync, [], (l) => l)).toEqual(["a", "c", "d"]);
  });
});

describe("three-owner cycle", () => {
  it("reports the pair whose edge is dropped, each pair once while it stays dropped", () => {
    const errors: LoomError[] = [];
    const reg = createHookRegistry({ onError: (e) => errors.push(e) });
    const pairs = (): string[] => errors.map((e) => [...e.pluginIds].sort().join("|"));
    reg.tap(sync, { owner: "a", before: ["b"] }, pass("a"));
    reg.tap(sync, { owner: "b", before: ["c"] }, pass("b"));
    expect(pairs()).toEqual([]);
    reg.tap(sync, { owner: "c", before: ["a"] }, pass("c")); // closes the cycle: c->a is dropped
    expect(pairs()).toEqual(["a|c"]);
    reg.tap(sync, { owner: "z" }, pass("z")); // same dropped edge, no new report
    reg.removeOwner("z");
    expect(pairs()).toEqual(["a|c"]);
    expect(reg.run(sync, [], (l) => l)).toEqual(["a", "b", "c"]);
  });

  it("when ranks move the dropped edge to another pair, that pair is reported once, the second reorder adds nothing", () => {
    const ranks = new Map([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
    const errors: LoomError[] = [];
    const reg = createHookRegistry({
      onError: (e) => errors.push(e),
      rankOf: (o) => ranks.get(o) ?? 9,
    });
    reg.tap(sync, { owner: "a", before: ["b"] }, pass("a"));
    reg.tap(sync, { owner: "b", before: ["c"] }, pass("b"));
    reg.tap(sync, { owner: "c", before: ["a"] }, pass("c"));
    const pairs = (): string[] => errors.map((e) => [...e.pluginIds].sort().join("|"));
    const first = pairs();
    expect(first).toHaveLength(1);
    ranks.set("a", 2).set("b", 0).set("c", 1);
    reg.reorder();
    reg.reorder();
    const after = pairs();
    expect(after.slice(0, 1)).toEqual(first);
    expect(after.length).toBeLessThanOrEqual(2);
    expect(new Set(after).size).toBe(after.length);
    expect(after).toEqual(["a|c", "a|b"]); // the cycle still exists, a different edge is dropped now: a new pair, reported once
  });
});
