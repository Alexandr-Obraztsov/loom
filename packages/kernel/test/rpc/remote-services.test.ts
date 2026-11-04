import { describe, expect, it } from "vitest";
import { createServiceRef } from "../../src/core/definitions.js";
import { createKernel } from "../../src/core/kernel.js";
import type { PluginDefinition } from "../../src/core/types.js";
import { createRpcEndpoint } from "../../src/rpc/endpoint.js";
import { createMemoryTransportPair } from "../../src/rpc/memory-transport.js";
import { exposeServices, remoteServicesPlugin } from "../../src/rpc/remote-services.js";
import { rejection } from "../core/kernel-helpers.js";

interface Greeter {
  greet(name: string): string;
  readonly label?: string;
}
interface AsyncGreeter {
  greet(name: string): Promise<string>;
}

const GreeterRef = createServiceRef<Greeter>("svc.greeter");

function greeterPlugin(id: string, prefix: string): PluginDefinition {
  return {
    id,
    version: "1.0.0",
    setup(ctx) {
      ctx.provide(GreeterRef, { greet: (name: string) => `${prefix} ${name}`, label: "x" });
    },
  };
}

async function setup(): Promise<{
  main: ReturnType<typeof createKernel>;
  win: ReturnType<typeof createKernel>;
  stop: () => void;
}> {
  const [ta, tb] = createMemoryTransportPair();
  const main = createKernel();
  await main.reconcile([greeterPlugin("hello", "hello")]);
  const stop = exposeServices(main, createRpcEndpoint(ta), [GreeterRef]);
  const win = createKernel();
  await win.reconcile([
    remoteServicesPlugin({
      id: "main-services",
      endpoint: createRpcEndpoint(tb),
      refs: [GreeterRef],
    }),
  ]);
  return { main, win, stop };
}

describe("remote services", () => {
  it("proxy methods return promises of the remote result; the plugin owns the provider", async () => {
    const { win } = await setup();
    const proxy = win.services.use(GreeterRef) as unknown as AsyncGreeter;
    await expect(proxy.greet("ann")).resolves.toBe("hello ann");
    const { greet } = proxy as unknown as Record<string, unknown>;
    expect(greet).toBe((proxy as unknown as Record<string, unknown>).greet);
    expect(win.services.providerOf(GreeterRef)).toBe("main-services");
    expect((proxy as unknown as { then?: unknown }).then).toBeUndefined();
    expect((proxy as unknown as Record<symbol, unknown>)[Symbol.iterator]).toBeUndefined();
  });

  it("connectServices proxy follows provider changes on the remote side", async () => {
    const { main, win } = await setup();
    const proxy = win.services.use(GreeterRef) as unknown as AsyncGreeter;
    await expect(proxy.greet("bo")).resolves.toBe("hello bo");
    await main.reconcile([greeterPlugin("hi", "hi")]);
    await expect(proxy.greet("bo")).resolves.toBe("hi bo");
    await main.reconcile([]);
    expect((await rejection(proxy.greet("bo"))).code).toBe("SERVICE_MISSING");
  });

  it("inherited members such as constructor are not callable remotely", async () => {
    const { win } = await setup();
    const proxy = win.services.use(GreeterRef) as unknown as Record<string, () => Promise<unknown>>;
    for (const name of ["constructor", "toString", "hasOwnProperty"]) {
      expect((await rejection(proxy[name]?.() as Promise<unknown>)).code).toBe("RPC_REMOTE_ERROR");
    }
  });

  it("non-function members reject with RPC_REMOTE_ERROR; stopping exposure removes handlers", async () => {
    const { win, stop } = await setup();
    const proxy = win.services.use(GreeterRef) as unknown as Record<string, () => Promise<unknown>>;
    expect((await rejection(proxy.label?.() as Promise<unknown>)).code).toBe("RPC_REMOTE_ERROR");
    stop();
    expect((await rejection(proxy.greet?.() as Promise<unknown>)).code).toBe("RPC_REMOTE_ERROR");
  });

  it("accepts an explicit plugin version", () => {
    const [t] = createMemoryTransportPair();
    expect(
      remoteServicesPlugin({ id: "r", version: "2.0.0", endpoint: createRpcEndpoint(t), refs: [] })
        .version,
    ).toBe("2.0.0");
  });
});

describe("class instances", () => {
  class Base {
    base(): string {
      return "base";
    }
  }
  let getterInvoked = false;
  class Counter extends Base {
    n = 0;
    inc(): number {
      return ++this.n;
    }
    get secret(): string {
      getterInvoked = true;
      return "secret";
    }
  }
  const CounterRef = createServiceRef<Counter>("svc.counter");

  async function counterProxy(): Promise<Record<string, () => Promise<unknown>>> {
    const [ta, tb] = createMemoryTransportPair();
    const main = createKernel();
    await main.reconcile([
      {
        id: "c",
        version: "1.0.0",
        setup: (ctx) => {
          ctx.provide(CounterRef, new Counter());
        },
      },
    ]);
    exposeServices(main, createRpcEndpoint(ta), [CounterRef]);
    const win = createKernel();
    await win.reconcile([
      remoteServicesPlugin({ id: "r", endpoint: createRpcEndpoint(tb), refs: [CounterRef] }),
    ]);
    return win.services.use(CounterRef) as unknown as Record<string, () => Promise<unknown>>;
  }

  it("class-instance service method is callable over rpc", async () => {
    const proxy = await counterProxy();
    await expect(proxy.inc?.()).resolves.toBe(1);
  });

  it("inherited method from a base class is callable", async () => {
    const proxy = await counterProxy();
    await expect(proxy.base?.()).resolves.toBe("base");
  });

  it("getter on the prototype is not invoked and is rejected", async () => {
    const proxy = await counterProxy();
    getterInvoked = false;
    const error = await rejection(proxy.secret?.() as Promise<unknown>);
    expect(error.code).toBe("RPC_REMOTE_ERROR");
    expect(error.message).toMatch(/has no method "secret"/);
    expect(getterInvoked).toBe(false);
    expect((await rejection(proxy.__proto__?.() as Promise<unknown>)).code).toBe(
      "RPC_REMOTE_ERROR",
    );
  });
});
