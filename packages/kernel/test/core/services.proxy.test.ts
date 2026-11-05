import { describe, expect, it } from "vitest";
import { LoomError } from "../../src/core/errors.js";
import { createServiceRegistry } from "../../src/core/services.js";
import type { ServiceRef } from "../../src/core/types.js";

interface Greeter {
  greet(name: string): string;
}
const ref: ServiceRef<Greeter> = { id: "greeter", kind: "service" };
const any = new Set(["A", "B", "O", "X", "D"]);
const impl = (tag: string): Greeter => ({ greet: (n) => `${tag}:${n}` });

function make(winners?: Record<string, string>, onError?: (e: unknown) => void) {
  return createServiceRegistry({
    kernelOwner: "kernel",
    ...(winners ? { winners } : {}),
    ...(onError ? { onError } : {}),
  });
}
function errorOf(fn: () => unknown): LoomError {
  try {
    fn();
  } catch (e) {
    if (e instanceof LoomError) return e;
    throw e;
  }
  throw new Error("did not throw");
}

describe("service proxy: class-valued members", () => {
  class Widget {
    static created = 0;
    static make(label: string): Widget {
      return new this(label);
    }
    constructor(readonly label: string, readonly extra = 1) {
      Widget.created += extra;
    }
  }
  interface Factory {
    Widget: typeof Widget;
  }
  const fref: ServiceRef<Factory> = { id: "factory", kind: "service" };

  it("keeps name, length, statics and new", () => {
    const r = make();
    r.provide(fref, { Widget }, "A");
    const W = r.use(fref, "C", any).Widget;
    expect(W.name).toBe("Widget");
    expect(W.length).toBe(1);
    expect(W.created).toBe(0);
    const w = new W("x");
    expect(w).toBeInstanceOf(Widget);
    expect(w.label).toBe("x");
    expect(W.make("y").label).toBe("y");
    expect(W.created).toBe(2);
    expect(Reflect.get(W, "prototype")).toBe(Widget.prototype);
  });

  it("a held class follows the active implementation, and subclassing works", () => {
    const r = make();
    r.provide(fref, { Widget }, "A");
    const W = r.use(fref, "C", any).Widget;
    class Other extends Widget {}
    r.override(fref, { Widget: Other }, "O");
    expect(new W("x")).toBeInstanceOf(Other);
    class Sub extends W {}
    expect(new Sub("s").label).toBe("s");
    r.removeOwner("O");
    r.removeOwner("A");
    expect(() => new W("x")).toThrow(/no active provider|no longer a function/);
  });

  it("plain methods are bare forwarders (no name/length mirroring) that still forward and refuse new", () => {
    const r = make();
    const add = (a: number, b: number): number => a + b;
    const sref: ServiceRef<{ add: typeof add }> = { id: "adder", kind: "service" };
    r.provide(sref, { add }, "A");
    const wrapped = r.use(sref, "C", any).add;
    expect(wrapped(1, 2)).toBe(3);
    expect(() => new (wrapped as unknown as new () => unknown)()).toThrow(TypeError);
  });

  it("a function with a prototype keeps its name and length through the proxy", () => {
    const r = make();
    function mul(a: number, b: number): number {
      return a * b;
    }
    const sref: ServiceRef<{ mul: typeof mul }> = { id: "muler", kind: "service" };
    r.provide(sref, { mul }, "A");
    const wrapped = r.use(sref, "C", any).mul;
    expect(wrapped.name).toBe("mul");
    expect(wrapped.length).toBe(2);
    expect(wrapped(2, 3)).toBe(6);
  });
});

describe("service proxy: per-consumer state", () => {
  it("two consumers get distinct method wrappers with their own attribution", () => {
    const r = make();
    const off = r.provide(ref, impl("a"), "A");
    const pa = r.use(ref, "ConsumerA", any);
    const pb = r.use(ref, "ConsumerB", any);
    const ga = Reflect.get<Greeter, "greet">(pa, "greet");
    const gb = Reflect.get<Greeter, "greet">(pb, "greet");
    expect(ga).not.toBe(gb);
    expect(ga("x")).toBe("a:x");
    expect(gb("x")).toBe("a:x");
    off();
    expect(errorOf(() => ga("x")).pluginIds).toEqual(["ConsumerA"]);
    expect(errorOf(() => gb("x")).pluginIds).toEqual(["ConsumerB"]);
  });

  it("a changed allowed set is noticed by content, also when one Set instance was mutated in place", () => {
    const r = make();
    r.provide(ref, impl("a"), "A");
    const allowed = new Set(["A"]);
    const p = r.use(ref, "C", allowed);
    expect(p.greet("x")).toBe("a:x");
    allowed.delete("A");
    expect(errorOf(() => r.use(ref, "C", allowed)).code).toBe("UNDECLARED_DEPENDENCY");
    expect(errorOf(() => p.greet("x")).code).toBe("UNDECLARED_DEPENDENCY");
    allowed.add("A");
    expect(r.use(ref, "C", allowed)).toBe(p);
    expect(p.greet("x")).toBe("a:x");
  });

  it("an equal set in another instance keeps the cached proxy", () => {
    const r = make();
    r.provide(ref, impl("a"), "A");
    expect(r.use(ref, "C", new Set(["A", "B"]))).toBe(r.use(ref, "C", new Set(["B", "A"])));
  });
});

describe("service proxy: leaked after its consumer was removed", () => {
  it("keeps following the ref after it was pruned and registered again", () => {
    const r = make();
    const off = r.provide(ref, impl("a"), "A");
    const leaked = r.use(ref, "C", any);
    expect(leaked.greet("x")).toBe("a:x");
    const before = r.version(ref);
    off();
    r.removeOwner("C");
    expect(r.stats().refs).toBe(0);
    r.provide(ref, impl("b"), "B");
    expect(leaked.greet("x")).toBe("b:x");
    expect(r.version(ref)).toBeGreaterThan(before);
    r.removeOwner("B");
    expect(errorOf(() => leaked.greet("x")).code).toBe("SERVICE_MISSING");
  });
});
