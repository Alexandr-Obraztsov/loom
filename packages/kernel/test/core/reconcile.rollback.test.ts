import { describe, expect, it, vi } from "vitest";

import { createHook, createServiceRef } from "../../src/core/definitions.js";
import { createKernel } from "../../src/core/kernel.js";
import { KernelRuntime } from "../../src/core/kernel-runtime.js";
import type { PluginsService } from "../../src/core/plugins-service.js";
import { PluginsRef } from "../../src/core/plugins-service.js";
import type { PluginDefinition } from "../../src/core/types.js";
import { must, plugin, rejection } from "./kernel-helpers.js";

interface Shown {
  label(): string;
}
const shown = createServiceRef<Shown>("rollback.shown");

describe("rollback leaves the tree reusable", () => {
  it("a no-op reconcile after a rollback keeps the root identity", async () => {
    const log: string[] = [];
    const k = createKernel();
    const source = (version: string): PluginDefinition =>
      plugin(log, "source", {
        version,
        provides: false,
        setup: (ctx) => {
          ctx.provide(shown, { label: () => `source@${version}` });
        },
      });
    const ui = plugin(log, "ui", {
      deps: ["source"],
      provides: false,
      extensions: [{ id: "app", factory: (ctx) => ctx.use(shown).label() }],
    });
    const boom = plugin(log, "boom", {
      provides: false,
      setup: () => Promise.reject(new Error("boom")),
    });
    const v1 = source("1.0.0");
    await k.reconcile([v1, ui]);
    const root = k.tree.root;
    expect(root?.value).toBe("source@1.0.0");
    expect((await rejection(k.reconcile([source("1.1.0"), ui, boom]))).code).toBe("SETUP_FAILED");
    expect(k.tree.root).toBe(root);
    await k.reconcile([v1, ui]);
    expect(k.tree.root).toBe(root);
  });
});

describe("rollback and ranks", () => {
  const order = createHook<string[], string[]>("rank.order", { mode: "sync" });
  const tapper = (log: string[], id: string, setup?: PluginDefinition["setup"]): PluginDefinition =>
    plugin(log, id, {
      provides: false,
      setup: async (ctx) => {
        ctx.tap(order, {}, (c, next) => next([...c, id]));
        await setup?.(ctx);
      },
    });

  it("a removed plugin keeps its tap position until it is torn down", async () => {
    const log: string[] = [];
    const k = createKernel();
    let during: string[] = [];
    const removed = tapper(log, "r", (ctx) => {
      ctx.onDispose(() => void (during = k.run(order, [], (c) => c)));
    });
    const stays = tapper(log, "s");
    await k.reconcile([removed, stays]);
    await k.reconcile([stays, tapper(log, "a")]);
    expect(during).toEqual(["r", "s"]);
    expect(k.run(order, [], (c) => c)).toEqual(["a", "s"]);
  });

  it("a failed reconcile that would reorder plugins leaves the tap order unchanged", async () => {
    const log: string[] = [];
    const k = createKernel();
    const [b, c] = [tapper(log, "b"), tapper(log, "c")];
    await k.reconcile([b, c]);
    const failing = plugin(log, "z", { provides: false, setup: () => Promise.reject(new Error("z")) });
    const a = tapper(log, "a");
    expect((await rejection(k.reconcile([a, b, c, failing]))).code).toBe("SETUP_FAILED");
    expect(k.run(order, [], (x) => x)).toEqual(["b", "c"]);
    await k.reconcile([a, b, c]);
    expect(k.run(order, [], (x) => x)).toEqual(["a", "b", "c"]);
  });

  it("reorders registries only when the rank of an existing owner moves", async () => {
    const rt = new KernelRuntime({}, () => undefined);
    const reorder = vi.spyOn(rt.hooks, "reorder");
    const run = (...ids: string[]): Promise<unknown> =>
      rt.pass({
        desired: ids.map((id) => tapper([], id)),
        config: rt.config,
        force: new Set(),
        freshServices: false,
      });
    await run("b");
    await run("b", "c");
    expect(reorder).not.toHaveBeenCalled();
    await rt.pass({
      desired: [tapper([], "a"), ...rt.active],
      config: rt.config,
      force: new Set(),
      freshServices: false,
    });
    expect(reorder).toHaveBeenCalledTimes(1);
  });
});

describe("rollback and state", () => {
  it("disable drops ctx.state and enable starts from an empty one", async () => {
    const log: string[] = [];
    const k = createKernel();
    let service: PluginsService | undefined;
    const seen: unknown[] = [];
    const host = plugin(log, "host", { setup: (ctx) => void (service = ctx.use(PluginsRef)) });
    const counter = plugin(log, "counter", { setup: (ctx) => void seen.push(ctx.state.n) });
    await k.reconcile([host, counter]);
    await must(service).disable("counter");
    await must(service).enable("counter");
    expect(seen).toEqual([1, 1]);
  });

  it("a failed pass restores the shallow snapshot of the state (nested objects are not copied)", async () => {
    const log: string[] = [];
    const k = createKernel();
    const nested = { hits: 0 };
    const a = plugin(log, "a", { setup: (ctx) => void (ctx.state.nested ??= nested) });
    await k.reconcile([a]);
    const err = await rejection(
      k.reconcile([
        plugin(log, "a", { version: "1.1.0", setup: (ctx) => void (ctx.state.extra = 1) }),
        plugin(log, "z", {
          setup: () => Promise.reject(new Error("z")),
        }),
      ]),
    );
    expect(err.code).toBe("SETUP_FAILED");
    let kept: Record<string, unknown> = {};
    await k.reconcile([
      plugin(log, "a", {
        version: "1.2.0",
        provides: false,
        setup: (ctx) => void (kept = ctx.state),
      }),
    ]);
    expect(kept.extra).toBeUndefined();
    expect(kept.nested).toBe(nested);
  });
});
