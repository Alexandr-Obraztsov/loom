import { describe, expect, it } from "vitest";
import { HostRef } from "../src/index.js";

describe("host", () => {
  it("HostRef has the id host", () => {
    expect(HostRef.id).toBe("host");
  });
});
