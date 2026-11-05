import { describe, expect, it } from "vitest";

import { createServiceRegistry } from "../../src/core/services.js";
import type { ServiceRef } from "../../src/core/types.js";

const a: ServiceRef<{ n: number }> = { id: "a", kind: "service" };
const b: ServiceRef<{ n: number }> = { id: "b", kind: "service" };

describe("service registry version", () => {
  it("version bumps on provide, override, decorate and removal and not on unrelated refs", () => {
    const reg = createServiceRegistry({ kernelOwner: "kernel" });
    const v0 = reg.version(a);
    const vb = reg.version(b);
    reg.provide(a, { n: 1 }, "P");
    const v1 = reg.version(a);
    expect(v1).toBeGreaterThan(v0);
    reg.override(a, { n: 2 }, "O");
    const v2 = reg.version(a);
    expect(v2).toBeGreaterThan(v1);
    const undo = reg.decorate(a, (prev) => ({ n: prev.n + 1 }), "D");
    const v3 = reg.version(a);
    expect(v3).toBeGreaterThan(v2);
    undo();
    const v4 = reg.version(a);
    expect(v4).toBeGreaterThan(v3);
    reg.removeOwner("O");
    expect(reg.version(a)).toBeGreaterThan(v4);
    expect(reg.version(b)).toBe(vb);
  });
});
