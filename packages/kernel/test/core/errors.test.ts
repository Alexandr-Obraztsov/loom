import { describe, expect, it } from "vitest";
import { LoomError } from "../../src/core/errors.js";

describe("LoomError", () => {
  it("carries code, pluginIds, details and is instanceof Error", () => {
    const cause = new Error("root");
    const err = new LoomError("SETUP_FAILED", "boom", {
      pluginIds: ["a", "b"],
      details: { x: 1 },
      cause,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(LoomError);
    expect(err.name).toBe("LoomError");
    expect(err.code).toBe("SETUP_FAILED");
    expect(err.message).toBe("boom");
    expect(err.pluginIds).toEqual(["a", "b"]);
    expect(err.details).toEqual({ x: 1 });
    expect(err.cause).toBe(cause);
  });

  it("defaults pluginIds to an empty array and omits details and cause", () => {
    const err = new LoomError("DISPOSED", "gone");
    expect(err.pluginIds).toEqual([]);
    expect(err.details).toBeUndefined();
    expect(err.cause).toBeUndefined();
  });
});

describe("LoomError details", () => {
  it("is an own property even when absent (contract: undefined, never missing)", () => {
    const err = new LoomError("DISPOSED", "gone");
    expect(Object.hasOwn(err, "details")).toBe(true);
    expect(err.details).toBeUndefined();
    expect(Object.hasOwn(err, "cause")).toBe(false);
  });
});
