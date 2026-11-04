import { describe, expect, it } from "vitest";
import { createKernel } from "../src/index.js";

describe("sdk smoke", () => {
  it("re-exports createKernel", () => {
    expect(typeof createKernel).toBe("function");
  });
});
