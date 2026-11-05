import { createKernel } from "@loom/kernel";
import { describe, expect, it } from "vitest";
import { attach, createExtension, createHook, createServiceRef, definePlugin } from "../src/index.js";
import type { ResolvedNode } from "../src/index.js";

interface Store {
  submit(text: string): Promise<string>;
}
interface Counter {
  count(): number;
}

const submit = createHook<{ text: string }, Promise<string>>("base.submit");
const storeRef = createServiceRef<Store>("base.store");
const counterRef = createServiceRef<Counter>("demo.counter");
const fallback = (c: { text: string }): Promise<string> => Promise.resolve(c.text);

const base = definePlugin({
  id: "base",
  version: "1.0.0",
  extensions: [createExtension({ id: "app", inputs: { panels: { multiple: true } }, factory: (ctx) => ctx.inputs })],
  setup(ctx) {
    ctx.provide(storeRef, {
      async submit(text) {
        const result = await ctx.run(submit, { text }, fallback);
        ctx.emit("base.submitted", result);
        return result;
      },
    });
  },
});

function demoPlugin(received: string[]) {
  return definePlugin({
    id: "demo",
    version: "1.0.0",
    dependsOn: { base: "^1.0.0" },
    extensions: [attach("app", "panels", { id: "demo-panel", title: "Demo" })],
    setup(ctx) {
      ctx.tap(submit, {}, (c, next) => next({ text: c.text.toUpperCase() }));
      ctx.provide(counterRef, { count: () => received.length });
      ctx.on<string>("base.submitted", (text) => void received.push(text));
    },
  });
}

describe("sdk end to end", () => {
  it("four mechanisms work together", async () => {
    const received: string[] = [];
    const kernel = createKernel();
    await kernel.reconcile([base, demoPlugin(received)]);

    const panels = kernel.tree.root?.inputs["panels"] as ResolvedNode<{ title: string }>[];
    expect(panels[0]?.value?.title).toBe("Demo");
    expect(kernel.services.use(counterRef).count()).toBe(0);

    expect(await kernel.run(submit, { text: "hi" }, fallback)).toBe("HI");
    expect(await kernel.services.use(storeRef).submit("hi")).toBe("HI");
    expect(received).toEqual(["HI"]);
    expect(kernel.services.use(counterRef).count()).toBe(1);

    await kernel.reconcile([base]);
    expect(kernel.tree.root?.inputs["panels"]).toEqual([]);
    expect(kernel.services.has(counterRef)).toBe(false);
    expect(await kernel.run(submit, { text: "hi" }, fallback)).toBe("hi");
    expect(await kernel.services.use(storeRef).submit("again")).toBe("again");
    expect(received).toEqual(["HI"]);
  });

  it("sdk exports only the public surface", async () => {
    expect(Object.keys(await import("../src/index.js")).sort()).toEqual(
      ["HostRef", "LoomError", "PluginsRef", "attach", "createExtension", "createHook", "createServiceRef", "definePlugin", "provideRemoteServices", "tapRemote"].sort(),
    );
  });
});
