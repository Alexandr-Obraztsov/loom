import { describe, expect, it, vi } from "vitest";
import { createKernel } from "../../src/core/kernel.js";
import { PluginsRef } from "../../src/core/plugins-service.js";
import type { PluginsService } from "../../src/core/plugins-service.js";
import { ids, must, plugin, rejection } from "./kernel-helpers.js";

async function withService() {
  const log: string[] = [];
  const k = createKernel();
  let svc: PluginsService | undefined;
  const host = plugin(log, "host", { provides: false, setup: (ctx) => void (svc = ctx.use(PluginsRef)) });
  await k.reconcile([host]);
  if (!svc) throw new Error("no service");
  return { k, log, svc, host };
}

describe("plugins service", () => {
  it("PluginsRef is usable by any plugin without declaring a dependency", async () => {
    const { svc, host, k } = await withService();
    expect(svc.list()).toEqual([{ id: "host", version: "1.0.0", enabled: true }]);
    expect(k.services.providerOf(PluginsRef)).toBe("kernel");
    expect(host.dependsOn).toBeUndefined();
  });

  it("install adds and enables the plugin", async () => {
    const { svc, k, log } = await withService();
    const diff = await svc.install(plugin(log, "good"));
    expect(diff.added).toEqual(["good"]);
    expect(ids(k.plugins)).toEqual(["good", "host"]);
    expect(svc.list().map((p) => p.id)).toEqual(["host", "good"]);
  });
});

describe("plugins service catalogue", () => {
  it("disable keeps definition but removes it from active set", async () => {
    const { svc, k, log } = await withService();
    const b = plugin(log, "b");
    await svc.install(b);
    const off = await svc.disable("b");
    expect(off.removed).toEqual(["b"]);
    expect(ids(k.plugins)).toEqual(["host"]);
    expect(svc.list()).toContainEqual({ id: "b", version: "1.0.0", enabled: false });
    await k.reconcile([must(k.plugins[0]), b]);
    expect(ids(k.plugins)).toEqual(["host"]);
    const on = await svc.enable("b");
    expect(on.added).toEqual(["b"]);
    expect(ids(k.plugins)).toEqual(["b", "host"]);
  });

  it("uninstall removes the plugin from the catalogue", async () => {
    const { svc, k, log } = await withService();
    await svc.install(plugin(log, "b"));
    const diff = await svc.uninstall("b");
    expect(diff.removed).toEqual(["b"]);
    expect(svc.list().map((p) => p.id)).toEqual(["host"]);
    expect(ids(k.plugins)).toEqual(["host"]);
  });

  it.each(["enable", "disable", "uninstall"] as const)("%s of an unknown id rejects with PLUGIN_UNKNOWN and changes nothing", async (method) => {
    const { svc, k } = await withService();
    const changed = vi.fn();
    k.on("plugins.changed", changed);
    const err = await rejection(svc[method]("nope"));
    expect(err.code).toBe("PLUGIN_UNKNOWN");
    expect(err.pluginIds).toEqual(["nope"]);
    expect(changed).not.toHaveBeenCalled();
    expect(svc.list().map((p) => p.id)).toEqual(["host"]);
  });

  it("reload re-runs setup even for the same definition object and keeps enabled state", async () => {
    const { svc, log } = await withService();
    const b = plugin(log, "b");
    await svc.install(b);
    log.length = 0;
    const diff = await svc.reload(b);
    expect(diff.reloaded).toEqual(["b"]);
    expect(log).toEqual(["dispose:b@1.0.0", "setup:b@1.0.0"]);
    await svc.disable("b");
    log.length = 0;
    await svc.reload(plugin(log, "b", { version: "1.2.0" }));
    expect(log).toEqual([]);
    expect(svc.list()).toContainEqual({ id: "b", version: "1.2.0", enabled: false });
  });

});

describe("plugins service replace and races", () => {
  it("reload of an unknown id installs it", async () => {
    const { svc, log } = await withService();
    expect((await svc.reload(plugin(log, "fresh"))).added).toEqual(["fresh"]);
    expect(svc.list().map((p) => p.id)).toEqual(["host", "fresh"]);
  });

  it("install of an existing id replaces it; a failed install leaves the catalogue unchanged", async () => {
    const { svc, k, log } = await withService();
    await svc.install(plugin(log, "b"));
    const diff = await svc.install(plugin(log, "b", { version: "1.1.0" }));
    expect(diff.reloaded).toEqual(["b"]);
    const err = await rejection(svc.install(plugin(log, "c", { deps: ["missing"] })));
    expect(err.code).toBe("DEPENDENCY_MISSING");
    expect(svc.list().map((p) => `${p.id}@${p.version}`)).toEqual(["host@1.0.0", "b@1.1.0"]);
    expect(ids(k.plugins)).toEqual(["b", "host"]);
  });

  it("reload racing an earlier uninstall rejects instead of reinstalling", async () => {
    const { svc, log } = await withService();
    const b = plugin(log, "b");
    await svc.install(b);
    const gone = svc.uninstall("b");
    const err = await rejection(svc.reload(b));
    await gone;
    expect(err.code).toBe("PLUGIN_UNKNOWN");
    expect(svc.list().map((p) => p.id)).toEqual(["host"]);
  });
});
