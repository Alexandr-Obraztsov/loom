import { describe, expect, it } from "vitest";
import { BeforeInstallHook, createKernel, definePlugin, KERNEL_ID, PluginsRef } from "../src/index.js";

describe("kernel smoke", () => {
  it("exports the kernel API", () => {
    expect(typeof createKernel).toBe("function");
    expect(KERNEL_ID).toBe("kernel");
    expect(PluginsRef.kind).toBe("service");
    expect(BeforeInstallHook.mode).toBe("async");
  });

  it("starts a plugin through the public entry", async () => {
    const kernel = createKernel();
    const diff = await kernel.reconcile([definePlugin({ id: "hello", version: "1.0.0" })]);
    expect(diff.added).toEqual(["hello"]);
    await kernel.dispose();
  });
});
