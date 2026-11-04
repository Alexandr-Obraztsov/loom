import { describe, expect, it } from "vitest";
import { createHook } from "../../src/core/definitions.js";
import type { LoomError } from "../../src/core/errors.js";
import { createKernel } from "../../src/core/kernel.js";
import type { PluginContext } from "../../src/core/types.js";
import { ids, plugin, refOf, rejection } from "./kernel-helpers.js";

const hook = createHook<number, number>("count", { mode: "sync" });

describe("reconcile", () => {
  it("first reconcile sets up plugins in dependency order", async () => {
    const log: string[] = [];
    const k = createKernel();
    const a = plugin(log, "a");
    const b = plugin(log, "b", { deps: ["a"] });
    const c = plugin(log, "c", { deps: ["b"] });
    const diff = await k.reconcile([c, a, b]);
    expect(log).toEqual(["setup:a@1.0.0", "setup:b@1.0.0", "setup:c@1.0.0"]);
    expect(diff).toEqual({ added: ["a", "b", "c"], removed: [], reloaded: [], requiresRestart: [] });
    expect(ids(k.plugins)).toEqual(["a", "b", "c"]);
  });

  it("adding a plugin sets up only it", async () => {
    const log: string[] = [];
    const k = createKernel();
    const a = plugin(log, "a");
    const b = plugin(log, "b", { deps: ["a"] });
    await k.reconcile([a, b]);
    log.length = 0;
    const diff = await k.reconcile([a, b, plugin(log, "d", { deps: ["a"] })]);
    expect(log).toEqual(["setup:d@1.0.0"]);
    expect(diff).toEqual({ added: ["d"], removed: [], reloaded: [], requiresRestart: [] });
  });

  it("changing a plugin reloads it and its dependents, not unrelated ones", async () => {
    const log: string[] = [];
    const k = createKernel();
    const b = plugin(log, "b", { deps: ["a"] });
    const x = plugin(log, "x");
    await k.reconcile([plugin(log, "a"), b, x]);
    log.length = 0;
    const diff = await k.reconcile([plugin(log, "a", { version: "1.1.0" }), b, x]);
    expect(log).toEqual(["dispose:b@1.0.0", "dispose:a@1.0.0", "setup:a@1.1.0", "setup:b@1.0.0"]);
    expect(diff.reloaded).toEqual(["a", "b"]);
    expect(k.services.use(refOf("a")).tag()).toBe("a@1.1.0");
  });

  it("removing a plugin disposes it and its dependents' registrations are gone", async () => {
    const log: string[] = [];
    const k = createKernel();
    const tapper = (ctx: PluginContext): void => {
      ctx.tap(hook, {}, (n, next) => next(n + 1));
    };
    const a = plugin(log, "a");
    const b = plugin(log, "b", { optional: ["a"], setup: tapper });
    const c = plugin(log, "c", { deps: ["a"], setup: tapper });
    await k.reconcile([a, b, c]);
    expect(k.run(hook, 0, (n) => n)).toBe(2);
    log.length = 0;
    const diff = await k.reconcile([b]);
    expect(log).toEqual(["dispose:c@1.0.0", "dispose:b@1.0.0", "dispose:a@1.0.0", "setup:b@1.0.0"]);
    expect(diff).toEqual({ added: [], removed: ["a", "c"], reloaded: ["b"], requiresRestart: [] });
    expect(k.services.has(refOf("a"))).toBe(false);
    expect(k.services.has(refOf("c"))).toBe(false);
    expect(k.run(hook, 0, (n) => n)).toBe(1);
  });

  it("state survives reload of the same id and is dropped on removal", async () => {
    const log: string[] = [];
    const k = createKernel();
    const seen: Record<string, unknown>[] = [];
    const a = (version: string) => plugin(log, "a", { version, setup: (ctx) => void seen.push(ctx.state) });
    await k.reconcile([a("1.0.0")]);
    await k.reconcile([a("1.1.0")]);
    expect(seen[1]).toBe(seen[0]);
    expect(seen[1]?.n).toBe(2);
    await k.reconcile([]);
    await k.reconcile([a("1.0.0")]);
    expect(seen[2]).not.toBe(seen[0]);
    expect(seen[2]?.n).toBe(1);
  });

});

describe("reconcile rollback", () => {
  it("setup throwing in the 3rd plugin rolls back the first two and restores previous versions with their state", async () => {
    const log: string[] = [];
    const k = createKernel();
    const failed: unknown[] = [];
    k.on("plugins.failed", (p) => failed.push(p));
    const states = new Map<string, Record<string, unknown>>();
    const keep = (ctx: PluginContext): void => void states.set(ctx.id, ctx.state);
    const v1 = [
      plugin(log, "a", { setup: keep }),
      plugin(log, "b", { deps: ["a"], setup: keep }),
      plugin(log, "c", { deps: ["b"], setup: keep }),
    ];
    await k.reconcile(v1);
    const tree = k.tree;
    const before = new Map([...states].map(([id, s]) => [id, s]));
    log.length = 0;
    const boom = new Error("boom");
    const err = await rejection(
      k.reconcile([
        plugin(log, "a", { version: "1.1.0", setup: (ctx) => void (ctx.state.mark = "v2") }),
        plugin(log, "b", { version: "1.1.0", deps: ["a"] }),
        plugin(log, "c", { version: "1.1.0", deps: ["b"], setup: () => Promise.reject(boom) }),
      ]),
    );
    expect(err.code).toBe("SETUP_FAILED");
    expect(err.pluginIds).toEqual(["c"]);
    expect(err.cause).toBe(boom);
    expect(err.details).toBeUndefined();
    expect(log).toEqual([
      "dispose:c@1.0.0", "dispose:b@1.0.0", "dispose:a@1.0.0",
      "setup:a@1.1.0", "setup:b@1.1.0", "setup:c@1.1.0", "dispose:c@1.1.0",
      "dispose:b@1.1.0", "dispose:a@1.1.0",
      "setup:a@1.0.0", "setup:b@1.0.0", "setup:c@1.0.0",
    ]);
    expect(failed).toEqual([{ error: err }]);
    expect(k.plugins).toEqual(v1);
    expect(k.tree).toBe(tree);
    for (const [id, state] of before) expect(states.get(id)).toBe(state);
    expect(states.get("a")).toEqual({ n: 2 });
    expect(k.services.use(refOf("c")).tag()).toBe("c@1.0.0");
  });

  it("SERVICE_CONFLICT during setup rolls back", async () => {
    const log: string[] = [];
    const k = createKernel();
    const a = plugin(log, "a");
    await k.reconcile([a]);
    const intruder = plugin(log, "b", {
      provides: false,
      setup: (ctx) => {
        ctx.tap(hook, {}, (n) => n * 100);
        ctx.provide(refOf("a"), { tag: () => "intruder" });
      },
    });
    const err = await rejection(k.reconcile([a, intruder]));
    expect(err.code).toBe("SETUP_FAILED");
    expect(err.pluginIds).toEqual(["b", "a"]);
    expect(err.details).toEqual({ causeCode: "SERVICE_CONFLICT" });
    expect((err.cause as LoomError).code).toBe("SERVICE_CONFLICT");
    expect(ids(k.plugins)).toEqual(["a"]);
    expect(k.services.providerOf(refOf("a"))).toBe("a");
    expect(k.run(hook, 1, (n) => n)).toBe(1);
  });

});

describe("reconcile ordering", () => {
  it("validation and graph errors reject before touching any running plugin", async () => {
    const log: string[] = [];
    const k = createKernel();
    const a = plugin(log, "a");
    await k.reconcile([a]);
    log.length = 0;
    const bad = { ...plugin(log, "Bad") };
    expect((await rejection(k.reconcile([a, bad]))).code).toBe("MANIFEST_INVALID");
    const orphan = plugin(log, "o", { deps: ["missing"] });
    expect((await rejection(k.reconcile([plugin(log, "a", { version: "1.1.0" }), orphan]))).code).toBe(
      "DEPENDENCY_MISSING",
    );
    expect((await rejection(k.reconcile([a, a]))).code).toBe("MANIFEST_INVALID");
    expect(log).toEqual([]);
    expect(k.plugins).toEqual([a]);
  });

  it("concurrent reconcile calls apply in order (second sees result of first)", async () => {
    const log: string[] = [];
    const k = createKernel();
    let release = (): void => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const a = plugin(log, "a", { setup: () => gate });
    const b = plugin(log, "b", { deps: ["a"] });
    const first = k.reconcile([a]);
    const second = k.reconcile([a, b]);
    const broken = k.reconcile([{ ...a, id: "BAD" }]);
    const third = k.reconcile([a, b, plugin(log, "c")]);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(log).toEqual(["setup:a@1.0.0"]);
    release();
    expect((await first).added).toEqual(["a"]);
    expect(await second).toEqual({ added: ["b"], removed: [], reloaded: [], requiresRestart: [] });
    expect((await rejection(broken)).code).toBe("MANIFEST_INVALID");
    expect((await third).added).toEqual(["c"]);
    expect(log).toEqual(["setup:a@1.0.0", "setup:b@1.0.0", "setup:c@1.0.0"]);
  });

});

describe("reconcile trust and results", () => {
  it("untrusted project plugin is skipped and reported via kernel.error", async () => {
    const log: string[] = [];
    const errors: LoomError[] = [];
    const denyBoom = new Error("trust store down");
    const k = createKernel({
      trust: (p) => {
        if (p.id === "broken") throw denyBoom;
        return Promise.resolve(p.id === "ok");
      },
    });
    k.on<LoomError>("kernel.error", (e) => errors.push(e));
    const ok = plugin(log, "ok", { scope: "project" });
    const no = plugin(log, "no", { scope: "project" });
    const broken = plugin(log, "broken", { scope: "project" });
    const user = plugin(log, "user", { scope: "user" });
    await k.reconcile([ok, no, broken, user]);
    expect(ids(k.plugins)).toEqual(["ok", "user"]);
    expect(errors.map((e) => [e.code, e.pluginIds])).toEqual([
      ["UNTRUSTED", ["no"]],
      ["UNTRUSTED", ["broken"]],
    ]);
    expect(errors[1]?.cause).toBe(denyBoom);

    const strict = createKernel();
    const strictErrors: LoomError[] = [];
    strict.on<LoomError>("kernel.error", (e) => strictErrors.push(e));
    await strict.reconcile([ok, user]);
    expect(ids(strict.plugins)).toEqual(["user"]);
    expect(strictErrors.map((e) => e.code)).toEqual(["UNTRUSTED"]);
  });

  it("requiresRestart lists plugins whose startup changed", async () => {
    const log: string[] = [];
    const k = createKernel();
    const b = plugin(log, "b", { deps: ["a"], startup: { mode: "x" } });
    await k.reconcile([plugin(log, "a", { startup: { native: ["m"], n: 1 } }), b]);
    const same = await k.reconcile([plugin(log, "a", { startup: { n: 1, native: ["m"] } }), b]);
    expect(same.reloaded).toEqual(["a", "b"]);
    expect(same.requiresRestart).toEqual([]);
    const changed = await k.reconcile([plugin(log, "a", { startup: { native: ["m", "k"], n: 1 } }), b]);
    expect(changed.requiresRestart).toEqual(["a"]);
    const dropped = await k.reconcile([plugin(log, "a"), b]);
    expect(dropped.requiresRestart).toEqual(["a"]);
  });

});

describe("reconcile tree and optional dependencies", () => {
  it("tree reflects extensions of active plugins after each reconcile", async () => {
    const log: string[] = [];
    const k = createKernel();
    const shell = plugin(log, "shell", {
      extensions: [{ id: "app", inputs: { items: { multiple: true } }, factory: () => "app" }],
    });
    const item = plugin(log, "item", {
      extensions: [{ id: "item", attachTo: { id: "app", input: "items" }, factory: () => "item" }],
    });
    expect(k.tree.root).toBeUndefined();
    await k.reconcile([shell, item]);
    const items = (): string[] => ((k.tree.root?.inputs.items ?? []) as readonly { id: string }[]).map((n) => n.id);
    expect(k.tree.root?.value).toBe("app");
    expect(items()).toEqual(["item"]);
    const tree = k.tree;
    await k.reconcile([shell, item]);
    expect(k.tree).toBe(tree);
    await k.reconcile([shell]);
    expect(items()).toEqual([]);
    const skin = plugin(log, "skin", { overrides: [{ id: "app", factory: () => "skinned" }] });
    await k.reconcile([shell, skin]);
    expect(k.tree.root?.value).toBe("skinned");
    expect(k.tree.root?.pluginId).toBe("skin");
  });

  it("optional dependency added later makes its dependent reload so it can use the new service", async () => {
    const log: string[] = [];
    const k = createKernel();
    const seen: string[] = [];
    const b = plugin(log, "b", {
      optional: ["a"],
      setup: (ctx) => {
        try {
          seen.push(ctx.use(refOf("a")).tag());
        } catch (e) {
          seen.push((e as LoomError).code);
        }
      },
    });
    await k.reconcile([b]);
    const diff = await k.reconcile([b, plugin(log, "a")]);
    expect(diff).toEqual({ added: ["a"], removed: [], reloaded: ["b"], requiresRestart: [] });
    expect(seen).toEqual(["SERVICE_MISSING", "a@1.0.0"]);
  });
});
