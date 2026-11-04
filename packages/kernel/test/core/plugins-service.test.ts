import { describe, expect, it } from "vitest";
import { createKernel } from "../../src/core/kernel.js";
import { BeforeInstallHook, PluginsRef } from "../../src/core/plugins-service.js";
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

  it("install runs BeforeInstallHook and rejects with INSTALL_DENIED", async () => {
    const log: string[] = [];
    const k = createKernel();
    const asked: string[] = [];
    let svc: PluginsService | undefined;
    const guard = plugin(log, "guard", {
      provides: false,
      setup: (ctx) => {
        svc = ctx.use(PluginsRef);
        ctx.tap(BeforeInstallHook, {}, ({ plugin: p }) => {
          asked.push(p.id);
          return Promise.resolve(p.id === "evil" ? { allow: false, reason: "blocked" } : { allow: true });
        });
      },
    });
    await k.reconcile([guard]);
    const err = await rejection(must(svc).install(plugin(log, "evil")));
    expect(err.code).toBe("INSTALL_DENIED");
    expect(err.pluginIds).toEqual(["evil"]);
    expect(err.details).toEqual({ reason: "blocked" });
    expect(err.message).toContain("blocked");
    expect(ids(k.plugins)).toEqual(["guard"]);
    const diff = await must(svc).install(plugin(log, "good"));
    expect(diff.added).toEqual(["good"]);
    expect(asked).toEqual(["evil", "good"]);
    expect(must(svc).list().map((p) => p.id)).toEqual(["guard", "good"]);
  });

  it("install denied without a reason still names the plugin", async () => {
    const { svc } = await withService();
    const log: string[] = [];
    await svc.install(
      plugin(log, "deny", {
        provides: false,
        setup: (ctx) => {
          ctx.tap(BeforeInstallHook, {}, () => Promise.resolve({ allow: false }));
        },
      }),
    );
    const err = await rejection(svc.install(plugin(log, "x")));
    expect(err.code).toBe("INSTALL_DENIED");
    expect(err.details).toEqual({});
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

  it("uninstall removes the plugin from the catalogue; unknown ids are no-ops", async () => {
    const { svc, k, log } = await withService();
    await svc.install(plugin(log, "b"));
    const diff = await svc.uninstall("b");
    expect(diff.removed).toEqual(["b"]);
    expect(svc.list().map((p) => p.id)).toEqual(["host"]);
    expect(await svc.uninstall("nope")).toEqual({ added: [], removed: [], reloaded: [], requiresRestart: [] });
    expect((await svc.disable("nope")).removed).toEqual([]);
    expect(ids(k.plugins)).toEqual(["host"]);
  });

  it("enable of an unknown id rejects", async () => {
    const { svc } = await withService();
    const err = await rejection(svc.enable("ghost"));
    expect(err.code).toBe("DEPENDENCY_MISSING");
    expect(err.pluginIds).toEqual(["ghost"]);
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
  it("reload of an unknown id installs it through BeforeInstallHook", async () => {
    const { svc, log } = await withService();
    await svc.install(
      plugin(log, "deny", {
        provides: false,
        setup: (ctx) => {
          ctx.tap(BeforeInstallHook, {}, () => Promise.resolve({ allow: false, reason: "no" }));
        },
      }),
    );
    expect((await rejection(svc.reload(plugin(log, "fresh")))).code).toBe("INSTALL_DENIED");
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

  it("reload racing an earlier uninstall rejects instead of bypassing BeforeInstallHook", async () => {
    const { svc, log } = await withService();
    const b = plugin(log, "b");
    await svc.install(b);
    const gone = svc.uninstall("b");
    const err = await rejection(svc.reload(b));
    await gone;
    expect(err.code).toBe("DEPENDENCY_MISSING");
    expect(svc.list().map((p) => p.id)).toEqual(["host"]);
  });
});
