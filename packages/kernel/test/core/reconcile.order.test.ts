import { describe, expect, it } from "vitest";
import { createHook, createServiceRef, definePlugin } from "../../src/core/definitions.js";
import { createKernel } from "../../src/core/kernel.js";
import type { PluginContext, PluginDefinition } from "../../src/core/types.js";
import { plugin, rejection } from "./kernel-helpers.js";

interface Named {
  name(): string;
}
const named = createServiceRef<Named>("named");
const chain = createHook<string[], string[]>("order.chain", { mode: "sync" });

function participant(log: string[], id: string, heard: string[], version = "1.0.0"): PluginDefinition {
  return plugin(log, id, {
    version,
    deps: ["p"],
    setup: (ctx: PluginContext) => {
      ctx.tap(chain, {}, (list, next) => next([...list, id]));
      ctx.on("order.ping", () => heard.push(id));
      ctx.decorate(named, (prev) => ({ name: () => `${prev.name()}${id.toUpperCase()}` }));
    },
  });
}

function scene() {
  const log: string[] = [];
  const heard: string[] = [];
  const k = createKernel();
  const p = plugin(log, "p", {
    setup: (ctx) => {
      ctx.provide(named, { name: () => "p" });
    },
  });
  const observe = (): { taps: string[]; listeners: string[]; decorated: string } => {
    heard.length = 0;
    k.services.use(PING).ping();
    return { taps: k.run(chain, [], (l) => l), listeners: [...heard], decorated: k.services.use(named).name() };
  };
  return { log, heard, k, p, observe };
}

interface Pinger {
  ping(): void;
}
const PING = createServiceRef<Pinger>("order.pinger");
const pinger = definePlugin({
  id: "pinger",
  version: "1.0.0",
  setup: (ctx) => {
    ctx.provide(PING, {
      ping: () => {
        ctx.emit("order.ping", 1);
      },
    });
  },
});

describe("reconcile keeps registration order stable", () => {
  it("rollback restores tap order, listener order and decorator output", async () => {
    const { log, heard, k, p, observe } = scene();
    const a = participant(log, "a", heard);
    const b = participant(log, "b", heard);
    await k.reconcile([p, a, b, pinger]);
    const before = observe();
    expect(before).toEqual({ taps: ["a", "b"], listeners: ["a", "b"], decorated: "pAB" });
    const z = plugin(log, "z", { setup: () => Promise.reject(new Error("z")) });
    const err = await rejection(k.reconcile([p, participant(log, "a", heard, "1.1.0"), b, pinger, z]));
    expect(err.code).toBe("SETUP_FAILED");
    expect(observe()).toEqual(before);
  });

  it("reloading a plugin does not move its registrations relative to unaffected plugins", async () => {
    const { log, heard, k, p, observe } = scene();
    const b = participant(log, "b", heard);
    await k.reconcile([p, participant(log, "a", heard), b, pinger]);
    const diff = await k.reconcile([p, participant(log, "a", heard, "1.1.0"), b, pinger]);
    expect(diff.reloaded).toEqual(["a"]);
    expect(observe()).toEqual({ taps: ["a", "b"], listeners: ["a", "b"], decorated: "pAB" });
  });
});

describe("plan-time extension conflicts", () => {
  const ext = (id: string) => ({ id, factory: () => id });

  it("extension id conflict rejects reconcile before touching running plugins", async () => {
    const log: string[] = [];
    const k = createKernel();
    const a = plugin(log, "a", { extensions: [ext("app"), ext("dup")] });
    await k.reconcile([a]);
    const tree = k.tree;
    log.length = 0;
    const b = plugin(log, "b", { extensions: [ext("dup")] });
    const err = await rejection(k.reconcile([plugin(log, "a", { version: "1.1.0", extensions: a.extensions ?? [] }), b]));
    expect(err.code).toBe("EXTENSION_CONFLICT");
    expect(err.pluginIds).toEqual(["a", "b"]);
    expect(err.details).toEqual({ conflicts: [{ id: "dup", pluginIds: ["a", "b"] }] });
    const o1 = plugin(log, "o1", { overrides: [ext("app")] });
    const o2 = plugin(log, "o2", { overrides: [ext("app")] });
    expect((await rejection(k.reconcile([a, o1, o2]))).pluginIds).toEqual(["o1", "o2"]);
    expect(log).toEqual([]);
    expect(k.plugins).toEqual([a]);
    expect(k.tree).toBe(tree);
  });

  it("winners entry resolves the conflict and reconcile succeeds", async () => {
    const log: string[] = [];
    const k = createKernel({ config: { winners: { dup: "b" } } });
    const a = plugin(log, "a", {
      extensions: [{ id: "app", inputs: { slot: {} }, factory: () => "app" }, { ...ext("dup"), attachTo: { id: "app", input: "slot" } }],
    });
    const b = plugin(log, "b", {
      extensions: [{ id: "dup", attachTo: { id: "app", input: "slot" }, factory: () => "b-dup" }],
    });
    const diff = await k.reconcile([a, b]);
    expect(diff.added).toEqual(["a", "b"]);
    const dup = k.tree.root?.inputs.slot as { pluginId: string; value: unknown } | undefined;
    expect(dup?.pluginId).toBe("b");
    expect(dup?.value).toBe("b-dup");
    expect(k.tree.errors).toEqual([]);
  });
});
