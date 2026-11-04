import { describe, expect, it } from "vitest";
import { createServiceRef } from "../../src/core/definitions.js";
import { createKernel } from "../../src/core/kernel.js";
import { plugin, rejection } from "./kernel-helpers.js";

interface Info {
  name(): string;
}
const InfoRef = createServiceRef<Info>("svc.info");
const info: Info = { name: () => "host-info" };

describe("host services", () => {
  it("host service is usable by a plugin without dependsOn", async () => {
    const log: string[] = [];
    let seen = "";
    const k = createKernel({ hostServices: [[InfoRef, info]] });
    const p = plugin(log, "p", { provides: false, setup: (ctx) => void (seen = ctx.use(InfoRef).name()) });
    await k.reconcile([p]);
    expect(seen).toBe("host-info");
    expect(p.dependsOn).toBeUndefined();
    expect(k.services.providerOf(InfoRef)).toBe("kernel");
  });

  it("host services survive reconcile and are removed on dispose", async () => {
    const log: string[] = [];
    const k = createKernel({ hostServices: [[InfoRef, info]] });
    expect(k.services.use(InfoRef).name()).toBe("host-info");
    await k.reconcile([plugin(log, "a")]);
    await k.reconcile([plugin(log, "b", { version: "2.0.0" })]);
    await k.reconcile([]);
    expect(k.services.has(InfoRef)).toBe(true);
    await k.setConfig({ winners: { "svc.x": "a" } });
    expect(k.services.use(InfoRef).name()).toBe("host-info");
    await k.dispose();
    expect(() => k.services.has(InfoRef)).toThrow(/disposed/i);
    expect((await rejection(k.reconcile([]))).code).toBe("DISPOSED");
  });
});
