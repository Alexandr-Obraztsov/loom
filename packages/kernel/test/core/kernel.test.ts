import { describe, expect, it, vi } from "vitest";
import { createHook } from "../../src/core/definitions.js";
import { LoomError } from "../../src/core/errors.js";
import { createKernel, KERNEL_ID } from "../../src/core/kernel.js";
import { KernelRuntime } from "../../src/core/kernel-runtime.js";
import { PluginsRef } from "../../src/core/plugins-service.js";
import type { PluginsService } from "../../src/core/plugins-service.js";
import { ids, must, plugin, refOf, rejection, thrown } from "./kernel-helpers.js";

const hook = createHook<number, number>("k.hook", { mode: "sync" });

describe("kernel config", () => {
  it("setConfig with new disabled list rebuilds tree without re-running setup (spy)", async () => {
    const log: string[] = [];
    const spy = vi.fn();
    const k = createKernel({ config: { rootId: "root" } });
    const p = plugin(log, "p", {
      setup: spy,
      extensions: [
        { id: "root", inputs: { kids: { multiple: true } }, factory: () => "root" },
        { id: "kid", attachTo: { id: "root", input: "kids" }, factory: () => "kid" },
      ],
    });
    await k.reconcile([p]);
    const kids = (): number => (k.tree.root?.inputs.kids as unknown[]).length;
    expect(kids()).toBe(1);
    const changed: unknown[] = [];
    k.on("plugins.changed", (d) => changed.push(d));
    await k.setConfig({ rootId: "root", disabled: ["kid"] });
    expect(kids()).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(changed).toEqual([{ added: [], removed: [], reloaded: [], requiresRestart: [] }]);
  });

  it("setConfig with changed plugin config reloads only that plugin with the new config", async () => {
    const log: string[] = [];
    const seen: unknown[] = [];
    const k = createKernel({ config: { plugins: { a: { n: 1 } } } });
    const a = plugin(log, "a", { setup: (ctx) => void seen.push(ctx.config) });
    await k.reconcile([a, plugin(log, "x")]);
    log.length = 0;
    await k.setConfig({ plugins: { a: { n: 2 } } });
    expect(log).toEqual(["dispose:a@1.0.0", "setup:a@1.0.0"]);
    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("setConfig with changed winners reloads everything and keeps kernel proxies live", async () => {
    const log: string[] = [];
    const shared = refOf("shared");
    const k = createKernel({ config: { winners: { [shared.id]: "b" } } });
    const offer = (id: string) => plugin(log, id, {
      setup: (ctx) => {
        ctx.provide(shared, { tag: () => id });
      },
    });
    await k.reconcile([offer("a"), offer("b")]);
    const proxy = k.services.use(shared);
    expect(proxy.tag()).toBe("b");
    log.length = 0;
    await k.setConfig({ winners: { [shared.id]: "a" } });
    expect(log).toEqual(["dispose:b@1.0.0", "dispose:a@1.0.0", "setup:a@1.0.0", "setup:b@1.0.0"]);
    expect(k.services.providerOf(shared)).toBe("a");
    expect(proxy.tag()).toBe("a");
    expect(Object.keys(proxy)).toEqual(["tag"]);
    expect("tag" in proxy).toBe(true);
  });

  it("a failed setConfig keeps the previous config and registry", async () => {
    const log: string[] = [];
    const shared = refOf("shared");
    const k = createKernel({ config: { winners: { [shared.id]: "b" } } });
    let calls = 0;
    const a = plugin(log, "a", {
      setup: (ctx) => {
        ctx.provide(shared, { tag: () => "a" });
        if (++calls === 2) throw new Error("second time");
      },
    });
    const b = plugin(log, "b", {
      setup: (ctx) => {
        ctx.provide(shared, { tag: () => "b" });
      },
    });
    await k.reconcile([a, b]);
    const proxy = k.services.use(shared);
    const err = await rejection(k.setConfig({ winners: {} }));
    expect(err.code).toBe("SETUP_FAILED");
    expect(proxy.tag()).toBe("b");
    await k.reconcile([a, b]);
    expect(k.services.providerOf(shared)).toBe("b");
  });

});

describe("kernel events and errors", () => {
  it("run and on act as the kernel owner; kernel errors are reported", async () => {
    const log: string[] = [];
    const k = createKernel();
    const errors: LoomError[] = [];
    const off = k.on<LoomError>("kernel.error", (e) => errors.push(e));
    await k.reconcile([
      plugin(log, "a", {
        setup: (ctx) => {
          ctx.tap(hook, {}, (n, next) => next(n * 2));
          ctx.on("ping", () => {
            throw new Error("listener");
          });
          ctx.emit("ping", 1);
        },
      }),
    ]);
    expect(k.run(hook, 2, (n) => n + 1)).toBe(5);
    expect(errors.map((e) => [e.code, e.pluginIds])).toEqual([["TAP_FAILED", ["a"]]]);
    off();
    await k.reconcile([plugin(log, "a", { scope: "project" })]);
    expect(errors).toHaveLength(1);
    expect(KERNEL_ID).toBe("kernel");
  });

  it("a throwing kernel.error listener does not recurse", async () => {
    const log: string[] = [];
    const k = createKernel();
    let calls = 0;
    k.on("kernel.error", () => {
      calls += 1;
      throw new Error("sink");
    });
    await k.reconcile([plugin(log, "u", { scope: "project" })]);
    expect(calls).toBe(1);
  });

  it("dispose errors of a plugin are reported and do not stop the reconcile", async () => {
    const log: string[] = [];
    const k = createKernel();
    const errors: LoomError[] = [];
    k.on<LoomError>("kernel.error", (e) => errors.push(e));
    const a = plugin(log, "a", {
      setup: (ctx) => {
        ctx.onDispose(() => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- a non-Error throw must be reported too
          throw "raw";
        });
      },
    });
    await k.reconcile([a]);
    const diff = await k.reconcile([]);
    expect(diff.removed).toEqual(["a"]);
    expect(errors.map((e) => [e.code, e.pluginIds])).toEqual([["TAP_FAILED", ["a"]]]);
  });

});

describe("kernel dispose and broken state", () => {
  it("dispose disposes all plugins in reverse order and further calls throw DISPOSED", async () => {
    const log: string[] = [];
    const k = createKernel();
    let svc: PluginsService | undefined;
    const a = plugin(log, "a", { setup: (ctx) => void (svc = ctx.use(PluginsRef)) });
    await k.reconcile([a, plugin(log, "b", { deps: ["a"] }), plugin(log, "c")]);
    log.length = 0;
    const pending = k.reconcile([a]);
    await k.dispose();
    expect((await pending).removed).toEqual(["b", "c"]);
    expect(log).toEqual(["dispose:c@1.0.0", "dispose:b@1.0.0", "dispose:a@1.0.0"]);
    expect(k.plugins).toEqual([]);
    expect(k.tree.root).toBeUndefined();
    const disposed = [
      await rejection(k.reconcile([])),
      await rejection(k.setConfig({})),
      await rejection(k.dispose()),
      await rejection(must(svc).install(a)),
      await rejection(must(svc).uninstall("a")),
      thrown(() => k.run(hook, 1, (n) => n)),
      thrown(() => k.on("x", () => undefined)),
      thrown(() => k.services.use(refOf("a"))),
      thrown(() => k.services.has(refOf("a"))),
      thrown(() => k.services.providerOf(refOf("a"))),
      thrown(() => must(svc).list()),
    ];
    expect(disposed.map((e) => e.code)).toEqual(Array<string>(disposed.length).fill("DISPOSED"));
    expect(disposed[0]).toBeInstanceOf(LoomError);
  });

  it("rollback that itself fails leaves the kernel broken but consistent", async () => {
    const log: string[] = [];
    const k = createKernel();
    const errors: LoomError[] = [];
    k.on<LoomError>("kernel.error", (e) => errors.push(e));
    let calls = 0;
    const a = plugin(log, "a", {
      setup: () => {
        if (++calls > 1) throw new Error(`a#${String(calls)}`);
      },
    });
    const b = plugin(log, "b", { deps: ["a"] });
    const x = plugin(log, "x");
    await k.reconcile([a, b, x]);
    const err = await rejection(k.reconcile([a, b, x, plugin(log, "z", { optional: ["a"] })]).then(
      () => k.reconcile([plugin(log, "a", { version: "1.1.0", setup: () => Promise.reject(new Error("v2")) }), b, x]),
    ));
    expect(err.code).toBe("SETUP_FAILED");
    expect(err.details).toEqual({ rollbackFailed: true, notRestored: ["a", "b", "z"] });
    expect(ids(k.plugins)).toEqual(["x"]);
    expect(errors.map((e) => [e.code, e.pluginIds])).toEqual([["SETUP_FAILED", ["a"]]]);
    expect(k.tree.root).toBeUndefined();
    expect((await k.reconcile([x])).removed).toEqual([]);
  });

});

describe("kernel services", () => {
  it("kernel service proxies are read-only and tree factories may use services", async () => {
    const log: string[] = [];
    const k = createKernel();
    const a = (version: string) =>
      plugin(log, "a", {
        version,
        extensions: [{ id: "app", factory: (ctx) => ctx.use(refOf("a")).tag() }],
      });
    await k.reconcile([a("1.0.0")]);
    expect(k.tree.root?.value).toBe("a@1.0.0");
    await k.reconcile([a("1.1.0")]);
    expect(k.tree.root?.value).toBe("a@1.1.0");
    const proxy = k.services.use(refOf("a")) as unknown as Record<string, unknown>;
    expect(() => (proxy.x = 1)).toThrow(TypeError);
    expect(() => delete proxy.tag).toThrow(TypeError);
    expect(() => Object.defineProperty(proxy, "y", { value: 1 })).toThrow(TypeError);
    expect(Object.getOwnPropertyDescriptor(proxy, "tag")?.configurable).toBe(true);
  });

  it("non-LoomError values reported to the kernel are wrapped as TAP_FAILED", () => {
    const rt = new KernelRuntime({}, () => undefined);
    const seen: LoomError[] = [];
    rt.events.on<LoomError>("kernel.error", "test", (e) => seen.push(e));
    rt.report("raw");
    rt.report(new Error("err"));
    expect(seen.map((e) => [e.code, e.message])).toEqual([
      ["TAP_FAILED", "raw"],
      ["TAP_FAILED", "err"],
    ]);
  });

  it("kernel-owned registrations come first and unknown owners last", () => {
    const rt = new KernelRuntime({}, () => undefined);
    const heard: string[] = [];
    rt.events.on("e", "stranger", () => heard.push("stranger"));
    rt.events.on("e", KERNEL_ID, () => heard.push("kernel"));
    rt.events.emit("e", 0);
    expect(heard).toEqual(["kernel", "stranger"]);
  });
});
