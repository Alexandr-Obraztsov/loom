import { describe, expect, it, vi } from "vitest";
import { createHook } from "../../src/core/definitions.js";
import { LoomError } from "../../src/core/errors.js";
import { createHookRegistry } from "../../src/core/hooks.js";

function setup() {
  const errors: LoomError[] = [];
  const reg = createHookRegistry({ onError: (e) => errors.push(e) });
  return { reg, errors };
}

const sync = createHook<number, number>("h.sync", { mode: "sync" });

describe("hook registry 1", () => {
  it("taps run in priority order", () => {
    const { reg } = setup();
    const seen: string[] = [];
    const mk = (name: string) => (c: number, next: (c: number) => number) => {
      seen.push(name);
      return next(c);
    };
    reg.tap(sync, "a", { priority: 1 }, mk("a"));
    reg.tap(sync, "b", { priority: 5 }, mk("b"));
    reg.tap(sync, "c", { priority: 5 }, mk("c"));
    reg.tap(sync, "d", {}, mk("d"));
    reg.run(sync, 0, () => 0);
    expect(seen).toEqual(["b", "c", "a", "d"]);
    expect(reg.taps(sync).map((t) => t.owner)).toEqual(["b", "c", "a", "d"]);
  });

  it("after/before constraints override priority", () => {
    const { reg, errors } = setup();
    reg.tap(sync, "low", { priority: 0 }, (c, n) => n(c));
    reg.tap(sync, "high", { priority: 10, after: ["low"] }, (c, n) => n(c));
    reg.tap(sync, "last", { priority: 100, after: ["high"] }, (c, n) => n(c));
    reg.tap(sync, "first", { priority: -5, before: ["low"], after: ["nobody"] }, (c, n) => n(c));
    expect(reg.taps(sync).map((t) => t.owner)).toEqual(["first", "low", "high", "last"]);
    expect(errors).toEqual([]);
  });

  it("match=false skips the tap and continues the chain", () => {
    const { reg } = setup();
    const skipped = vi.fn();
    reg.tap(sync, "a", { priority: 2, match: (c) => c > 5 }, (c, n) => {
      skipped();
      return n(c);
    });
    reg.tap(sync, "b", {}, (c, n) => n(c) + 1);
    expect(reg.run(sync, 1, (c) => c)).toBe(2);
    expect(skipped).not.toHaveBeenCalled();
    expect(reg.run(sync, 9, (c) => c)).toBe(10);
    expect(skipped).toHaveBeenCalledTimes(1);
  });

  it("tap can change ctx passed to next", () => {
    const { reg } = setup();
    reg.tap(sync, "a", {}, (c, n) => n(c + 100));
    expect(reg.run(sync, 1, (c) => c)).toBe(101);
  });
});

describe("hook registry 2", () => {
  it("tap can change result returned by next", () => {
    const { reg } = setup();
    reg.tap(sync, "a", {}, (c, n) => n(c) * 2);
    expect(reg.run(sync, 4, (c) => c)).toBe(8);
  });

  it("tap that does not call next short-circuits", () => {
    const { reg } = setup();
    const fb = vi.fn((c: number) => c);
    reg.tap(sync, "a", { priority: 1 }, () => 42);
    const later = vi.fn();
    reg.tap(sync, "b", {}, (c, n) => {
      later();
      return n(c);
    });
    expect(reg.run(sync, 1, fb)).toBe(42);
    expect(fb).not.toHaveBeenCalled();
    expect(later).not.toHaveBeenCalled();
  });

  it("removeOwner removes all taps of owner", () => {
    const { reg } = setup();
    const other = createHook<number, number>("h.other", { mode: "sync" });
    reg.tap(sync, "a", {}, (c, n) => n(c) + 1);
    reg.tap(sync, "a", {}, (c, n) => n(c) + 1);
    reg.tap(other, "a", {}, (c, n) => n(c) + 1);
    reg.tap(sync, "b", {}, (c, n) => n(c) + 100);
    reg.removeOwner("a");
    expect(reg.taps(sync).map((t) => t.owner)).toEqual(["b"]);
    expect(reg.taps(other)).toEqual([]);
    expect(reg.run(sync, 0, (c) => c)).toBe(100);
    reg.removeOwner("nobody");
  });

  it("tap remover is idempotent and removes exactly that tap", () => {
    const { reg } = setup();
    const off1 = reg.tap(sync, "a", {}, (c, n) => n(c) + 1);
    reg.tap(sync, "a", {}, (c, n) => n(c) + 10);
    off1();
    off1();
    expect(reg.run(sync, 0, (c) => c)).toBe(10);
    const offB = reg.tap(sync, "b", {}, (c, n) => n(c));
    reg.removeOwner("a");
    reg.removeOwner("b");
    offB();
    reg.tap(sync, "c", {}, (c, n) => n(c));
    offB();
    expect(reg.taps(sync).map((t) => t.owner)).toEqual(["c"]);
  });
});

describe("hook registry 3", () => {
  it("taps added or removed during a run do not affect that run", () => {
    const { reg } = setup();
    const seen: string[] = [];
    let offB: () => void = () => undefined;
    reg.tap(sync, "a", { priority: 2 }, (c, n) => {
      seen.push("a");
      offB();
      reg.tap(sync, "late", { priority: 1 }, (x, nn) => {
        seen.push("late");
        return nn(x);
      });
      return n(c);
    });
    offB = reg.tap(sync, "b", {}, (c, n) => {
      seen.push("b");
      return n(c);
    });
    reg.run(sync, 0, (c) => c);
    expect(seen).toEqual(["a", "b"]);
    seen.length = 0;
    reg.run(sync, 0, (c) => c);
    expect(seen).toEqual(["a", "late"]);
  });

  it("ordering cache is reused across runs (sort runs once per change, spy)", () => {
    const { reg } = setup();
    reg.tap(sync, "a", {}, (c, n) => n(c));
    reg.tap(sync, "b", {}, (c, n) => n(c));
    const spy = vi.spyOn(Array.prototype, "sort");
    try {
      for (let i = 0; i < 5; i++) reg.run(sync, 0, (c) => c);
      reg.taps(sync);
      expect(spy).not.toHaveBeenCalled();
      reg.tap(sync, "plain", {}, (c, n) => n(c));
      expect(spy).not.toHaveBeenCalled(); // binary insert, no sort
      reg.tap(sync, "c", { before: ["a"] }, (c, n) => n(c));
      expect(spy).toHaveBeenCalledTimes(1); // full recompute
      for (let i = 0; i < 5; i++) reg.run(sync, 0, (c) => c);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
