import { describe, expect, it } from "vitest";
import { inRange, isRange, isVersion } from "../../src/core/versions.js";

describe("memoized semver predicates", () => {
  it("answer like semver, repeatedly", () => {
    for (let i = 0; i < 2; i++) {
      expect(isVersion("1.2.3")).toBe(true);
      expect(isVersion("1.2")).toBe(false);
      expect(isRange("^1.0.0")).toBe(true);
      expect(isRange("not a range")).toBe(false);
      expect(inRange("1.5.0", "^1.0.0")).toBe(true);
      expect(inRange("2.0.0-beta.1", ">=1.0.0")).toBe(true);
      expect(inRange("2.0.0", "^1.0.0")).toBe(false);
    }
  });

  it("reject a v prefix and an empty range, which semver itself accepts", () => {
    expect(isVersion("v1.0.0")).toBe(false);
    expect(isVersion("=1.0.0")).toBe(false);
    expect(isVersion(" 1.0.0")).toBe(false);
    expect(isVersion("1.0.0 ")).toBe(false);
    expect(isRange("")).toBe(false);
    expect(isRange("*")).toBe(true);
  });

  it("accept prerelease and build metadata", () => {
    for (const v of ["1.0.0+build.5", "1.0.0-beta.1+sha.abc", "1.0.0-rc.1"]) expect(isVersion(v), v).toBe(true);
  });

  it("stay correct after the bounded cache is dropped and refilled", () => {
    for (let i = 0; i < 5000; i++) expect(inRange(`1.0.${String(i)}`, "^1.0.0")).toBe(true);
    expect(inRange("1.0.1", "^2.0.0")).toBe(false);
    expect(inRange("1.0.0", "^1.0.0")).toBe(true);
  });
});
