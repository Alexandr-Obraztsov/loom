import { describe, expect, it } from "vitest";
import { createKernel } from "../src/index.js";

describe("kernel smoke", () => {
  it("exports createKernel", () => {
    expect(typeof createKernel).toBe("function");
  });

  it("is a placeholder", () => {
    expect(() => createKernel()).toThrow("not implemented");
  });
});
