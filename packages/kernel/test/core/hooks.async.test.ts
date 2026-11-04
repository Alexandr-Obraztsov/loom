import { describe, expect, it } from "vitest";
import { createHook } from "../../src/core/definitions.js";
import { LoomError } from "../../src/core/errors.js";
import { createHookRegistry } from "../../src/core/hooks.js";

function setup() {
  const errors: LoomError[] = [];
  const reg = createHookRegistry({ onError: (e) => errors.push(e) });
  return { reg, errors };
}

const asyncHook = createHook<number, Promise<number>>("h.async");

describe("hook registry (async) 1", () => {
  it("async hook awaits each tap", async () => {
    const { reg } = setup();
    const seen: string[] = [];
    reg.tap(asyncHook, "a", { priority: 1 }, async (c, n) => {
      seen.push("a-in");
      const r = await n(c + 1);
      seen.push("a-out");
      return r * 2;
    });
    reg.tap(asyncHook, "b", {}, async (c, n) => {
      await Promise.resolve();
      seen.push("b-in");
      return n(c + 1);
    });
    await expect(reg.run(asyncHook, 0, (c) => Promise.resolve(c))).resolves.toBe(4);
    expect(seen).toEqual(["a-in", "b-in", "a-out"]);
  });

  it("async: sync throw becomes a rejection, rejection is wrapped once", async () => {
    const { reg, errors } = setup();
    reg.tap(asyncHook, "outer", { priority: 1 }, (c, n) => n(c));
    reg.tap(asyncHook, "inner", {}, () => {
      throw new Error("sync boom");
    });
    const p = reg.run(asyncHook, 0, (c) => Promise.resolve(c));
    await expect(p).rejects.toMatchObject({ code: "TAP_FAILED", pluginIds: ["inner"] });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.cause).toBeInstanceOf(Error);
  });

  it("async: rejection from tap is wrapped with owner and cause", async () => {
    const { reg, errors } = setup();
    const cause = new Error("nope");
    reg.tap(asyncHook, "a", {}, () => Promise.reject(cause));
    await expect(reg.run(asyncHook, 0, (c) => Promise.resolve(c))).rejects.toMatchObject({
      pluginIds: ["a"],
      cause,
    });
    expect(errors).toHaveLength(1);
  });

  it("async: next twice rejects on the second call, first result unaffected", async () => {
    const { reg, errors } = setup();
    let first: number | undefined;
    reg.tap(asyncHook, "a", {}, async (c, n) => {
      first = await n(c);
      return n(c);
    });
    await expect(reg.run(asyncHook, 3, (c) => Promise.resolve(c))).rejects.toMatchObject({
      code: "TAP_FAILED",
    });
    expect(first).toBe(3);
    expect(errors).toHaveLength(1);
  });
});

describe("hook registry (async) 2", () => {
  it("async: fallback sync throw rejects, not wrapped by taps", async () => {
    const { reg, errors } = setup();
    reg.tap(asyncHook, "a", {}, (c, n) => n(c));
    const boom = new Error("fb");
    await expect(
      reg.run(asyncHook, 0, () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    await expect(reg.run(asyncHook, 0, () => Promise.reject(boom))).rejects.toBe(boom);
    expect(errors).toEqual([]);
  });

  it("async: match throwing rejects", async () => {
    const { reg } = setup();
    reg.tap(
      asyncHook,
      "m",
      {
        match: () => {
          throw new Error("bad match");
        },
      },
      (c, n) => n(c),
    );
    await expect(reg.run(asyncHook, 0, (c) => Promise.resolve(c))).rejects.toMatchObject({
      pluginIds: ["m"],
    });
  });
});

describe("hook registry (async passthrough)", () => {
  it("accepts plain values from async-hook taps and fallbacks", async () => {
    const { reg } = setup();
    const plain = asyncHook;
    reg.tap(plain, "a", {}, (c, n) => n(c));
    reg.tap(plain, "b", { priority: -1 }, ((c: number, n: (c: number) => unknown) =>
      n(c)) as never);
    const fb = ((c: number) => c + 1) as unknown as (c: number) => Promise<number>;
    await expect(Promise.resolve(reg.run(plain, 1, fb))).resolves.toBe(2);
  });

  it("throws non-Error fallback values as rejections", async () => {
    const { reg } = setup();
    await expect(
      reg.run(asyncHook, 0, () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercising non-Error throw
        throw "str";
      }),
    ).rejects.toBeDefined();
  });
});
