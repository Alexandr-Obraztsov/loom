import { describe, expect, it } from "vitest";
import { createHook } from "../../src/core/definitions.js";
import { LoomError } from "../../src/core/errors.js";
import { createHookRegistry } from "../../src/core/hooks.js";

function setup() {
  const errors: LoomError[] = [];
  const reg = createHookRegistry({ onError: (e) => errors.push(e) });
  return { reg, errors };
}

const sync = createHook<number, number>("h.sync", { mode: "sync" });

describe("hook registry (failures) 1", () => {
  it("run with no taps calls fallback", () => {
    const { reg } = setup();
    expect(reg.run(sync, 2, (c) => c * 10)).toBe(20);
  });

  it("throwing tap reports TAP_FAILED with owner and rethrows", () => {
    const { reg, errors } = setup();
    const cause = new Error("boom");
    reg.tap(sync, "outer", { priority: 1 }, (c, n) => n(c));
    reg.tap(sync, "bad", {}, () => {
      throw cause;
    });
    let caught: unknown;
    try {
      reg.run(sync, 0, (c) => c);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LoomError);
    expect(caught).toMatchObject({ code: "TAP_FAILED", pluginIds: ["bad"], cause });
    expect(errors).toEqual([caught]);
  });

  it("fallback errors propagate unchanged and unreported", () => {
    const { reg, errors } = setup();
    reg.tap(sync, "a", {}, (c, n) => n(c));
    const boom = new Error("fb");
    expect(() =>
      reg.run(sync, 0, () => {
        throw boom;
      }),
    ).toThrow(boom);
    expect(errors).toEqual([]);
  });

  it("match throwing counts as a throwing tap", () => {
    const { reg, errors } = setup();
    reg.tap(
      sync,
      "m",
      {
        match: () => {
          throw new Error("bad match");
        },
      },
      (c, n) => n(c),
    );
    expect(() => reg.run(sync, 0, (c) => c)).toThrow(expect.objectContaining({ code: "TAP_FAILED", pluginIds: ["m"] }));
    expect(errors).toHaveLength(1);
  });
});

describe("hook registry (failures) 2", () => {
  it("calling next twice throws TAP_FAILED; first result unaffected", () => {
    const { reg, errors } = setup();
    let first: number | undefined;
    reg.tap(sync, "a", {}, (c, n) => {
      first = n(c);
      return n(c);
    });
    expect(() => reg.run(sync, 7, (c) => c)).toThrow(expect.objectContaining({ code: "TAP_FAILED", pluginIds: ["a"] }));
    expect(first).toBe(7);
    expect(errors).toHaveLength(1);
  });

  it("a tap may swallow the next-twice error; it is still reported once", () => {
    const { reg, errors } = setup();
    reg.tap(sync, "a", {}, (c, n) => {
      n(c);
      try {
        n(c);
      } catch {
        // swallowed
      }
      return 1;
    });
    expect(reg.run(sync, 0, (c) => c)).toBe(1);
    expect(errors).toHaveLength(1);
  });

  it("sync hook rejects a Promise-returning tap", async () => {
    const { reg, errors } = setup();
    const rejecting = Promise.reject(new Error("late"));
    reg.tap(sync, "p", {}, (() => rejecting) as unknown as (c: number) => number);
    expect(() => reg.run(sync, 0, (c) => c)).toThrow(expect.objectContaining({ code: "TAP_FAILED", pluginIds: ["p"] }));
    expect(errors).toHaveLength(1);
    await Promise.resolve();
  });

  it("sync hook rejects a thenable fallback with empty pluginIds", () => {
    const { reg, errors } = setup();
    reg.tap(sync, "outer", {}, (c, n) => n(c));
    const fb = (() => ({ then: () => undefined })) as unknown as (c: number) => number;
    expect(() => reg.run(sync, 0, fb)).toThrow(expect.objectContaining({ code: "TAP_FAILED", pluginIds: [] }));
    expect(errors).toHaveLength(1);
    expect(() => reg.run(sync, 0, (() => Promise.resolve(1)) as unknown as (c: number) => number)).toThrow(
      expect.objectContaining({ pluginIds: [] }),
    );
  });
});

describe("hook registry (failures) 3", () => {
  it("contradictory before/after reports and still runs every tap once", () => {
    const { reg, errors } = setup();
    const seen: string[] = [];
    const mk = (name: string) => (c: number, n: (c: number) => number) => {
      seen.push(name);
      return n(c);
    };
    reg.tap(sync, "a", { before: ["b"] }, mk("a"));
    expect(errors).toEqual([]);
    reg.tap(sync, "b", { before: ["a"] }, mk("b"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "TAP_FAILED", pluginIds: ["b", "a"] });
    reg.run(sync, 0, (c) => c);
    expect(seen).toEqual(["a", "b"]);
  });

  it("a tap without constraints that closes a cycle is isolated", () => {
    const { reg, errors } = setup();
    reg.tap(sync, "a", { after: ["c"] }, (c, n) => n(c));
    reg.tap(sync, "b", { before: ["c"], after: ["a"] }, (c, n) => n(c));
    expect(errors).toEqual([]);
    reg.tap(sync, "c", {}, (c, n) => n(c));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.pluginIds).toContain("c");
    expect(reg.taps(sync)).toHaveLength(3);
  });

  it("a self-contradicting owner reports once", () => {
    const { reg, errors } = setup();
    reg.tap(sync, "a", { before: ["x"] }, (c, n) => n(c));
    reg.tap(sync, "x", { before: ["a"], after: ["a"] }, (c, n) => n(c));
    expect(errors).toHaveLength(1);
    expect(reg.taps(sync).map((t) => t.owner)).toEqual(["a", "x"]);
  });

  it("a throwing onError does not mask the tap failure", () => {
    const reg = createHookRegistry({
      onError: () => {
        throw new Error("sink");
      },
    });
    reg.tap(sync, "a", {}, () => {
      throw new Error("tap");
    });
    expect(() => reg.run(sync, 0, (c) => c)).toThrow(expect.objectContaining({ code: "TAP_FAILED" }));
  });
});

describe("hook registry (failures) 4", () => {
  it("a non-Error tap throw is wrapped with its string form", () => {
    const { reg } = setup();
    reg.tap(sync, "a", {}, () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercising non-Error throw
      throw "plain";
    });
    expect(() => reg.run(sync, 0, (c) => c)).toThrow(/plain/);
  });
});
