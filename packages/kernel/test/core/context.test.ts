import { describe, expect, it, vi } from "vitest";

import { createPluginContext } from "../../src/core/context.js";
import { createHook, createServiceRef, definePlugin } from "../../src/core/definitions.js";
import { LoomError } from "../../src/core/errors.js";
import { createEventBus } from "../../src/core/events.js";
import { createHookRegistry } from "../../src/core/hooks.js";
import { createServiceRegistry } from "../../src/core/services.js";

interface Greeter {
  greet(name: string): string;
}
const ref = createServiceRef<Greeter>("greeter");
const hook = createHook<number, number>("h", { mode: "sync" });
const greeter = (tag: string): Greeter => ({ greet: (n) => `${tag}:${n}` });

function make(id = "P", allowed: string[] = [], state: Record<string, unknown> = {}) {
  const services = createServiceRegistry({ kernelOwner: "kernel" });
  const hooks = createHookRegistry({ onError: () => undefined });
  const events = createEventBus({ onError: () => undefined });
  const plugin = definePlugin({ id, version: "1.0.0" });
  const made = createPluginContext({
    plugin,
    allowed: new Set(allowed),
    config: { a: 1 },
    state,
    services,
    hooks,
    events,
  });
  return { ...made, services, hooks, events };
}

function codeOf(fn: () => unknown): LoomError {
  try {
    fn();
  } catch (e) {
    if (e instanceof LoomError) return e;
    throw e;
  }
  throw new Error("did not throw");
}

describe("plugin context", () => {
  it("registrations are attributed to the plugin id", () => {
    const { ctx, services, hooks } = make("P");
    ctx.provide(ref, greeter("a"));
    expect(services.providerOf(ref)).toBe("P");
    ctx.override(ref, greeter("o"));
    expect(services.providerOf(ref)).toBe("P");
    ctx.decorate(ref, (prev) => ({ greet: (n) => `d(${prev.greet(n)})` }));
    ctx.tap(hook, {}, (c, next) => next(c + 1));
    expect(hooks.taps(hook).map((t) => t.owner)).toEqual(["P"]);
    expect(ctx.id).toBe("P");
    expect(ctx.config).toEqual({ a: 1 });
  });

  it("dispose removes services, taps, listeners and runs onDispose in reverse", async () => {
    const { ctx, dispose, services, hooks, events } = make("P");
    const order: string[] = [];
    ctx.provide(ref, greeter("a"));
    ctx.tap(hook, {}, (c, next) => next(c + 1));
    const listener = vi.fn();
    ctx.on("e", listener);
    ctx.onDispose(() => void order.push("first"));
    ctx.onDispose(async () => {
      await Promise.resolve();
      order.push("second");
    });
    await dispose();
    expect(order).toEqual(["second", "first"]);
    expect(services.has(ref)).toBe(false);
    expect(hooks.run(hook, 1, (c) => c)).toBe(1);
    events.emit("e", 1);
    expect(listener).not.toHaveBeenCalled();
  });

  it("dispose still removes registrations when onDispose throws, then rethrows; idempotent", async () => {
    const { ctx, dispose, services } = make("P");
    ctx.provide(ref, greeter("a"));
    ctx.onDispose(() => {
      throw new Error("boom");
    });
    const first = dispose();
    await expect(first).rejects.toThrow(AggregateError);
    expect(services.has(ref)).toBe(false);
    expect(dispose()).toBe(first);
  });

  it("dispose resolves for a clean plugin and a repeat call returns the same promise", async () => {
    const { dispose } = make();
    const p = dispose();
    await p;
    expect(dispose()).toBe(p);
  });

  it("dispose removes the plugin's override and decorator, restoring the base service", async () => {
    const { ctx, dispose, services } = make("P");
    services.provide(ref, greeter("base"), "kernel");
    ctx.override(ref, greeter("over"));
    ctx.decorate(ref, (prev) => ({ greet: (n) => `deco(${prev.greet(n)})` }));
    expect(services.use(ref, "kernel", new Set(["P"])).greet("x")).toBe("deco(over:x)");
    await dispose();
    expect(services.use(ref, "kernel", new Set(["P"])).greet("x")).toBe("base:x");
  });

  it("onDispose callbacks cannot use ctx: it is closed before they run", async () => {
    const { ctx, dispose } = make("P");
    let seen: LoomError | undefined;
    ctx.onDispose(() => {
      seen = codeOf(() => ctx.use(ref));
    });
    await dispose();
    expect(seen?.code).toBe("DISPOSED");
  });
});

describe("plugin context (use, state, dispose guard)", () => {
  it("use of undeclared plugin's service throws UNDECLARED_DEPENDENCY", () => {
    const { ctx, services } = make("C", []);
    services.provide(ref, greeter("a"), "A");
    expect(codeOf(() => ctx.use(ref)).code).toBe("UNDECLARED_DEPENDENCY");
  });

  it("use of optional dependency's service works when present", () => {
    const { ctx, services } = make("C", ["A"]);
    services.provide(ref, greeter("a"), "A");
    expect(ctx.use(ref).greet("x")).toBe("a:x");
  });

  it("run, on and emit work through the context", () => {
    const { ctx } = make("P");
    ctx.tap(hook, {}, (c, next) => next(c * 2));
    expect(ctx.run(hook, 2, (c) => c + 1)).toBe(5);
    const got: number[] = [];
    ctx.on<number>("e", (p) => got.push(p));
    ctx.emit("e", 7);
    expect(got).toEqual([7]);
  });

  it("state object is the same instance passed in", () => {
    const state = { k: 1 };
    expect(make("P", [], state).ctx.state).toBe(state);
  });

});

describe("plugin context (dispose race)", () => {
  it("registrations are rejected while dispose is in progress", async () => {
    const { ctx, dispose, services, hooks, events } = make("P");
    ctx.provide(ref, greeter("a"));
    ctx.tap(hook, {}, (c, next) => next(c + 1));
    const listener = vi.fn();
    ctx.on("e", listener);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    ctx.onDispose(() => gate);
    const done = dispose();
    const calls: (() => unknown)[] = [
      () => {
        ctx.provide(ref, greeter("b"));
      },
      () => {
        ctx.tap(hook, {}, (c, next) => next(c));
      },
      () => {
        ctx.on("e", () => undefined);
      },
      () => {
        ctx.onDispose(() => undefined);
      },
    ];
    for (const call of calls) expect(codeOf(call).code).toBe("DISPOSED");
    release();
    await done;
    expect(services.has(ref)).toBe(false);
    expect(hooks.taps(hook)).toEqual([]);
    events.emit("e", 1);
    expect(listener).not.toHaveBeenCalled();
  });

});

describe("plugin context (after dispose)", () => {
  it("methods after dispose throw DISPOSED", async () => {
    const { ctx, dispose } = make("P");
    await dispose();
    const calls: (() => unknown)[] = [
      () => {
        ctx.provide(ref, greeter("a"));
      },
      () => {
        ctx.override(ref, greeter("a"));
      },
      () => {
        ctx.decorate(ref, (p) => p);
      },
      () => {
        ctx.use(ref);
      },
      () => {
        ctx.tap(hook, {}, (c, next) => next(c));
      },
      () => {
        ctx.run(hook, 1, (c) => c);
      },
      () => {
        ctx.on("e", () => undefined);
      },
      () => {
        ctx.emit("e", 1);
      },
      () => {
        ctx.onDispose(() => undefined);
      },
    ];
    for (const call of calls) {
      const err = codeOf(call);
      expect(err.code).toBe("DISPOSED");
      expect(err.pluginIds).toEqual(["P"]);
    }
    expect(ctx.id).toBe("P");
    expect(ctx.config).toEqual({ a: 1 });
    expect(ctx.state).toEqual({});
  });
});
