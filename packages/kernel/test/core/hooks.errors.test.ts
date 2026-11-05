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
const asyncHook = createHook<number, Promise<number>>("h.async");

describe("hook registry (failures) 1", () => {
  it("run with no taps calls fallback", () => {
    const { reg } = setup();
    expect(reg.run(sync, 2, (c) => c * 10)).toBe(20);
  });

  it("throwing tap reports TAP_FAILED with owner and rethrows", () => {
    const { reg, errors } = setup();
    const cause = new Error("boom");
    reg.tap(sync, { owner: "outer", priority: 1 }, (c, n) => n(c));
    reg.tap(sync, { owner: "bad" }, () => {
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
    reg.tap(sync, { owner: "a" }, (c, n) => n(c));
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
      sync, { owner: "m", match: () => {
          throw new Error("bad match");
        }, }, (c, n) => n(c),
    );
    expect(() => reg.run(sync, 0, (c) => c)).toThrow(
      expect.objectContaining({ code: "TAP_FAILED", pluginIds: ["m"] }),
    );
    expect(errors).toHaveLength(1);
  });
});

describe("hook registry (failures) 2", () => {
  it("calling next twice throws TAP_FAILED; first result unaffected", () => {
    const { reg, errors } = setup();
    let first: number | undefined;
    reg.tap(sync, { owner: "a" }, (c, n) => {
      first = n(c);
      return n(c);
    });
    expect(() => reg.run(sync, 7, (c) => c)).toThrow(
      expect.objectContaining({ code: "TAP_FAILED", pluginIds: ["a"] }),
    );
    expect(first).toBe(7);
    expect(errors).toHaveLength(1);
  });

  it("a tap may swallow the next-twice error; it is still reported once", () => {
    const { reg, errors } = setup();
    reg.tap(sync, { owner: "a" }, (c, n) => {
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
    reg.tap(sync, { owner: "p" }, (() => rejecting) as unknown as (c: number) => number);
    expect(() => reg.run(sync, 0, (c) => c)).toThrow(
      expect.objectContaining({ code: "TAP_FAILED", pluginIds: ["p"] }),
    );
    expect(errors).toHaveLength(1);
    await Promise.resolve();
  });

  it("sync hook rejects a thenable fallback with empty pluginIds", () => {
    const { reg, errors } = setup();
    reg.tap(sync, { owner: "outer" }, (c, n) => n(c));
    const fb = (() => ({ then: () => undefined })) as unknown as (c: number) => number;
    expect(() => reg.run(sync, 0, fb)).toThrow(
      expect.objectContaining({ code: "TAP_FAILED", pluginIds: [] }),
    );
    expect(errors).toHaveLength(1);
    expect(() =>
      reg.run(sync, 0, (() => Promise.resolve(1)) as unknown as (c: number) => number),
    ).toThrow(expect.objectContaining({ pluginIds: [] }));
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
    reg.tap(sync, { owner: "a", before: ["b"] }, mk("a"));
    expect(errors).toEqual([]);
    reg.tap(sync, { owner: "b", before: ["a"] }, mk("b"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "TAP_FAILED", pluginIds: ["b", "a"] });
    reg.run(sync, 0, (c) => c);
    expect(seen).toEqual(["a", "b"]);
  });

  it("a cycle closed by a constraint-free tap drops only the last-considered edge", () => {
    const { reg, errors } = setup();
    reg.tap(sync, { owner: "a", after: ["c"] }, (c, n) => n(c));
    reg.tap(sync, { owner: "b", before: ["c"], after: ["a"] }, (c, n) => n(c));
    expect(errors).toEqual([]);
    reg.tap(sync, { owner: "c" }, (c, n) => n(c));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.pluginIds).toEqual(["b", "a"]);
    expect(reg.taps(sync)).toHaveLength(3);
  });

  it("a self-contradicting owner reports once", () => {
    const { reg, errors } = setup();
    reg.tap(sync, { owner: "a", before: ["x"] }, (c, n) => n(c));
    reg.tap(sync, { owner: "x", before: ["a"], after: ["a"] }, (c, n) => n(c));
    expect(errors).toHaveLength(1);
    expect(reg.taps(sync).map((t) => t.owner)).toEqual(["a", "x"]);
  });

  it("a throwing onError does not mask the tap failure", () => {
    const reg = createHookRegistry({
      onError: () => {
        throw new Error("sink");
      },
    });
    reg.tap(sync, { owner: "a" }, () => {
      throw new Error("tap");
    });
    expect(() => reg.run(sync, 0, (c) => c)).toThrow(
      expect.objectContaining({ code: "TAP_FAILED" }),
    );
  });
});

describe("hook registry (failures) 4", () => {
  it("a non-Error tap throw is wrapped with its string form", () => {
    const { reg } = setup();
    reg.tap(sync, { owner: "a" }, () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercising non-Error throw
      throw "plain";
    });
    expect(() => reg.run(sync, 0, (c) => c)).toThrow(/plain/);
  });
});

describe("hook registry (self-healing order)", () => {
  const owners = (reg: ReturnType<typeof setup>["reg"]) => reg.taps(sync).map((t) => t.owner);

  it("earlier tap's non-contradictory constraint survives a later contradicting tap", () => {
    const { reg, errors } = setup();
    reg.tap(sync, { owner: "a", before: ["b"] }, (c, n) => n(c));
    reg.tap(sync, { owner: "c" }, (c, n) => n(c));
    reg.tap(sync, { owner: "b", priority: 10, before: ["a"] }, (c, n) => n(c));
    expect(owners(reg)).toEqual(["a", "b", "c"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.pluginIds).toEqual(["b", "a"]);
  });

  it("removing the contradicting partner restores dropped constraints", () => {
    const { reg, errors } = setup();
    reg.tap(sync, { owner: "m", before: ["n"] }, (c, n) => n(c));
    reg.tap(sync, { owner: "n", before: ["o"] }, (c, n) => n(c));
    reg.tap(sync, { owner: "o", before: ["m"] }, (c, n) => n(c));
    expect(owners(reg)).toEqual(["m", "n", "o"]);
    expect(errors).toHaveLength(1);
    reg.removeOwner("n");
    expect(owners(reg)).toEqual(["o", "m"]);
    expect(errors).toHaveLength(1);
  });

  it("a constraint dropped once is reported once, not on every recompute", () => {
    const { reg, errors } = setup();
    reg.tap(sync, { owner: "a", before: ["b"] }, (c, n) => n(c));
    reg.tap(sync, { owner: "b", before: ["a"] }, (c, n) => n(c));
    expect(errors).toHaveLength(1);
    reg.tap(sync, { owner: "z" }, (c, n) => n(c));
    reg.tap(sync, { owner: "w" }, (c, n) => n(c));
    reg.removeOwner("z");
    expect(errors).toHaveLength(1);
    expect(owners(reg)).toEqual(["a", "b", "w"]);
  });

  it("plugin-forged TAP_FAILED is re-wrapped with the real owner and reported", () => {
    const { reg, errors } = setup();
    const forged = new LoomError("TAP_FAILED", "forged", { pluginIds: ["victim"] });
    reg.tap(sync, { owner: "evil" }, () => {
      throw forged;
    });
    expect(() => reg.run(sync, 0, (c) => c)).toThrow(
      expect.objectContaining({ pluginIds: ["evil"], cause: forged }),
    );
    expect(errors).toHaveLength(1);
  });

  it("non-object fallback throw is not attributed to any plugin (sync and async)", async () => {
    const { reg, errors } = setup();
    reg.tap(sync, { owner: "innocent" }, (c, n) => n(c));
    reg.tap(asyncHook, { owner: "innocent" }, (c, n) => n(c));
    let sCaught: unknown;
    try {
      reg.run(sync, 0, () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercising non-Error throw
        throw "fb";
      });
    } catch (e) {
      sCaught = e;
    }
    expect(sCaught).toBeInstanceOf(Error);
    expect(sCaught).toMatchObject({ cause: "fb" });
    expect(sCaught).not.toBeInstanceOf(LoomError);
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- non-Error rejection under test
    const failing = (): Promise<number> => Promise.reject({ code: 1 });
    const rejected: unknown = await reg.run(asyncHook, 0, failing).catch((e: unknown) => e);
    expect(rejected).toEqual({ code: 1 });
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- non-Error rejection under test
    const failingStr = (): Promise<number> => Promise.reject("s");
    const rejectedStr: unknown = await reg.run(asyncHook, 0, failingStr).catch((e: unknown) => e);
    expect(rejectedStr).toMatchObject({ cause: "s" });
    expect(rejectedStr).not.toBeInstanceOf(LoomError);
    expect(errors).toEqual([]);
  });
});
