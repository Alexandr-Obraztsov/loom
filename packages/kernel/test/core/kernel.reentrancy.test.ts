import { describe, expect, it, vi } from "vitest";

import { createServiceRef } from "../../src/core/definitions.js";
import type { LoomError } from "../../src/core/errors.js";
import { createKernel } from "../../src/core/kernel.js";
import { KernelRuntime } from "../../src/core/kernel-runtime.js";
import type { PluginsService } from "../../src/core/plugins-service.js";
import { PluginsRef } from "../../src/core/plugins-service.js";
import { must, plugin, rejection } from "./kernel-helpers.js";

describe("PluginsService called from setup or teardown", () => {
  it("setup awaiting plugins.reload fails the pass with REENTRANT_RECONCILE instead of hanging", async () => {
    const log: string[] = [];
    const k = createKernel();
    const other = plugin(log, "other");
    const p = plugin(log, "p", {
      setup: (ctx) =>
        ctx
          .use(PluginsRef)
          .reload(other)
          .then(() => undefined),
    });
    const started = Date.now();
    const err = await rejection(k.reconcile([p]));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(err.code).toBe("SETUP_FAILED");
    expect(err.pluginIds).toEqual(["p"]);
    expect(err.details).toEqual({ causeCode: "REENTRANT_RECONCILE" });
    expect(k.plugins).toEqual([]);
  });

  it("every mutating method is refused, list still works", async () => {
    const k = createKernel();
    const codes: string[] = [];
    let listed: unknown;
    const p = plugin([], "p", {
      setup: async (ctx) => {
        const svc = ctx.use(PluginsRef);
        listed = svc.list();
        for (const call of [
          () => svc.install(p),
          () => svc.uninstall("p"),
          () => svc.enable("p"),
          () => svc.disable("p"),
        ]) {
          codes.push(((await rejection(call())).details as { causeCode: string }).causeCode);
        }
      },
    });
    await k.reconcile([p]);
    expect(codes).toEqual(Array<string>(4).fill("REENTRANT_RECONCILE"));
    expect(listed).toEqual([]);
  });

  it("onDispose awaiting the service is refused too, and the teardown still completes", async () => {
    const k = createKernel();
    const errors: LoomError[] = [];
    k.on<LoomError>("kernel.error", (e) => errors.push(e));
    const p = plugin([], "p", {
      setup: (ctx) => {
        const plugins = ctx.use(PluginsRef); // taken in setup: ctx itself is closed when onDispose runs
        ctx.onDispose(() => plugins.uninstall("p").then(() => undefined));
      },
    });
    await k.reconcile([p]);
    await k.reconcile([]);
    expect(errors.map((e) => e.code)).toEqual(["TAP_FAILED"]);
    const cause = errors[0]?.cause;
    const inner: unknown = cause instanceof AggregateError ? cause.errors[0] : cause;
    expect((inner as LoomError).details).toEqual({ causeCode: "REENTRANT_RECONCILE" });
  });

  it("a plugin may use the service after its setup finished, and others during its setup", async () => {
    const log: string[] = [];
    const k = createKernel();
    let service: PluginsService | undefined;
    const late = plugin(log, "late", { setup: (ctx) => void (service = ctx.use(PluginsRef)) });
    await k.reconcile([late]);
    expect((await must(service).install(plugin(log, "extra"))).added).toEqual(["extra"]);
    expect(
      must(service)
        .list()
        .map((e) => e.id),
    ).toEqual(["late", "extra"]);
  });
});

describe("undetected re-entrancy (documented limit)", () => {
  it("another plugin's handle used from a setup is not refused: it stays queued until the pass ends", async () => {
    const log: string[] = [];
    const k = createKernel();
    const handle = createServiceRef<{ plugins: PluginsService }>("reentrancy.handle");
    const owner = plugin(log, "owner", {
      provides: false,
      setup: (ctx) => {
        ctx.provide(handle, { plugins: ctx.use(PluginsRef) });
      },
    });
    let call: Promise<unknown> | undefined;
    let wasPendingDuringSetup = false;
    const user = plugin(log, "user", {
      deps: ["owner"],
      provides: false,
      setup: async (ctx) => {
        let isSettled = false;
        call = ctx
          .use(handle)
          .plugins.install(plugin(log, "late"))
          .finally(() => {
            isSettled = true;
          });
        await new Promise((resolve) => setTimeout(resolve, 30)); // awaiting `call` here would hang the pass
        wasPendingDuringSetup = !isSettled;
      },
    });
    await k.reconcile([owner, user]);
    expect(wasPendingDuringSetup).toBe(true);
    await must(call);
    expect(k.plugins.map((p) => p.id)).toContain("late");
  });
});

describe("kernel dispose", () => {
  it("a failed teardown still closes the hook batch", async () => {
    const rt = new KernelRuntime({}, () => undefined);
    await rt.pass({
      desired: [plugin([], "a")],
      config: rt.config,
      force: new Set(),
      freshServices: false,
    });
    const resume = vi.fn();
    vi.spyOn(rt.hooks, "defer").mockReturnValue(resume);
    vi.spyOn(
      rt as unknown as { teardown(id: string): Promise<void> },
      "teardown",
    ).mockRejectedValue(new Error("teardown"));
    await expect(rt.disposeAll()).rejects.toThrow("teardown");
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("dispose after a failed dispose returns the same rejected promise", async () => {
    const k = createKernel();
    vi.spyOn(KernelRuntime.prototype, "disposeAll").mockRejectedValue(new Error("stuck"));
    try {
      const first = k.dispose();
      await expect(first).rejects.toThrow("stuck");
      expect(k.dispose()).toBe(first);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
