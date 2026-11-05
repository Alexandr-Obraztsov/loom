import { describe, expect, it, vi } from "vitest";
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

describe("service proxy without a provider", () => {
  it("can be awaited: then is undefined, so it resolves to the proxy itself", async () => {
    const r = make();
    const p = r.use(ref, "C", any);
    expect(Reflect.get(p, "then")).toBeUndefined();
    expect(await Promise.resolve(p)).toBe(p);
  });

  it("reads Symbol.toStringTag so it can be logged; every other member is SERVICE_MISSING", () => {
    const r = make();
    const p = r.use(ref, "C", any);
    expect(Object.prototype.toString.call(p)).toBe("[object LoomService(greeter)]");
    expect(errorOf(() => p.greet("x")).code).toBe("SERVICE_MISSING");
    expect(errorOf(() => Reflect.get(p, "then2")).code).toBe("SERVICE_MISSING");
    expect(errorOf(() => "then" in p).code).toBe("SERVICE_MISSING");
  });

  it("forwards a real then of the implementation once a provider exists, and is undefined again after it is gone", async () => {
    const r = make();
    const thenable = { then: vi.fn((cb: (v: string) => void) => {
        cb("resolved");
      }) };
    const tref: ServiceRef<typeof thenable> = { id: "thenable", kind: "service" };
    const off = r.provide(tref, thenable, "A");
    const p = r.use(tref, "C", any);
    expect(typeof p.then).toBe("function");
    expect(await p).toBe("resolved");
    expect(thenable.then).toHaveBeenCalledOnce();
    off();
    expect(Reflect.get(p, "then")).toBeUndefined();
  });
});

describe("service proxy invariants", () => {
  it("Object.freeze is refused with the proxy's own TypeError, and the proxy keeps working", () => {
    const r = make();
    r.provide(ref, impl("a"), "A");
    const p = r.use(ref, "C", any);
    expect(() => Object.freeze(p)).toThrow(/cannot prevent extensions on service "greeter"/);
    expect(Object.isExtensible(p)).toBe(true);
    expect(Object.keys(p)).toEqual(["greet"]);
    expect(p.greet("x")).toBe("a:x");
  });

  it("forwards the prototype so instanceof and inherited members work", () => {
    class Base {
      hello(): string {
        return "hi";
      }
    }
    class Derived extends Base {}
    const cref: ServiceRef<Derived> = { id: "derived", kind: "service" };
    const r = make();
    r.provide(cref, new Derived(), "A");
    const p = r.use(cref, "C", any);
    expect(Object.getPrototypeOf(p)).toBe(Derived.prototype);
    expect(p instanceof Base).toBe(true);
    expect(p.hello()).toBe("hi");
  });
});

describe("service registry: onChange only for a changed active implementation", () => {
  it("a registration that does not become active, and its removal, are silent", () => {
    const r = make({ greeter: "A" });
    const off = r.provide(ref, impl("a"), "A");
    const spy = vi.fn();
    r.onChange(spy);
    const version = r.version(ref);
    const offB = r.provide(ref, impl("b"), "B");
    expect(r.providerOf(ref)).toBe("A");
    offB();
    expect(spy).not.toHaveBeenCalled();
    expect(r.version(ref)).toBe(version);
    off();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(r.version(ref)).toBe(0);
  });

  it("a registration that takes over (configured winner) fires once", () => {
    const r = make({ greeter: "B" });
    r.provide(ref, impl("a"), "A");
    const spy = vi.fn();
    r.onChange(spy);
    r.provide(ref, impl("b"), "B");
    expect(spy).toHaveBeenCalledOnce();
    expect(r.providerOf(ref)).toBe("B");
  });

  it("removeOwner is silent for a ref whose active implementation it did not supply", () => {
    const r = make({ greeter: "A" });
    r.provide(ref, impl("a"), "A");
    r.provide(ref, impl("b"), "B");
    const spy = vi.fn();
    r.onChange(spy);
    r.removeOwner("B");
    expect(spy).not.toHaveBeenCalled();
  });

  it("reorder is silent when the active implementation stays", () => {
    const rank: Record<string, number> = { A: 0, B: 1 };
    const r = createServiceRegistry({ kernelOwner: "kernel", winners: { greeter: "A" }, rankOf: (o) => rank[o] ?? 0 });
    r.provide(ref, impl("a"), "A");
    r.provide(ref, impl("b"), "B");
    const spy = vi.fn();
    r.onChange(spy);
    rank["A"] = 2;
    r.reorder();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("service registry: throwing onChange listener", () => {
  it("with onError the registration succeeds, the remover is returned and the error is reported", () => {
    const errors: unknown[] = [];
    const r = make(undefined, (e) => errors.push(e));
    r.onChange(() => {
      throw new Error("boom");
    });
    const off = r.provide(ref, impl("a"), "A");
    expect(errors).toHaveLength(1);
    expect(r.providerOf(ref)).toBe("A");
    off();
    expect(r.providerOf(ref)).toBeUndefined();
  });

  it("without onError the error is thrown with the registration in effect; removeOwner reclaims it", () => {
    const r = make();
    r.onChange(() => {
      throw new Error("boom");
    });
    expect(errorOf(() => r.provide(ref, impl("a"), "A")).code).toBe("TAP_FAILED");
    expect(r.providerOf(ref)).toBe("A");
    expect(() => {
      r.removeOwner("A");
    }).toThrow();
    expect(r.has(ref)).toBe(false);
    expect(r.stats()).toEqual({ refs: 0, owners: 0, consumers: 0 });
  });
});

describe("service registry: indexes shrink", () => {
  it("single removers return every index to its starting size", () => {
    const r = make();
    const start = r.stats();
    const offs = [r.provide(ref, impl("a"), "A"), r.override(ref, impl("o"), "O"), r.decorate(ref, (p) => p, "D")];
    expect(r.stats()).toMatchObject({ refs: 1, owners: 3 });
    for (const off of offs) off();
    expect(r.stats()).toEqual(start);
  });

  it("an owner keeps its index entry while it still holds another registration on the ref", () => {
    const r = make();
    const offA = r.provide(ref, impl("a"), "A");
    const offD = r.decorate(ref, (p) => p, "A");
    offA();
    expect(r.stats().owners).toBe(1);
    offD();
    expect(r.stats().owners).toBe(0);
  });

  it("removeOwner of a provider and of a consumer drops the ref once no proxy of it is held", () => {
    const r = make();
    const start = r.stats();
    r.provide(ref, impl("a"), "A");
    r.use(ref, "C", any);
    r.removeOwner("A");
    expect(r.stats()).toMatchObject({ refs: 1, owners: 0, consumers: 1 });
    r.removeOwner("C");
    expect(r.stats()).toEqual(start);
  });

  it("lookups of unknown refs create nothing, and a dropped then recreated ref never repeats a version", () => {
    const r = make();
    expect(r.has(ref)).toBe(false);
    expect(r.providerOf(ref)).toBeUndefined();
    expect(r.version(ref)).toBe(0);
    expect(r.stats().refs).toBe(0);
    const off = r.provide(ref, impl("a"), "A");
    const first = r.version(ref);
    off();
    expect(r.stats().refs).toBe(0);
    r.provide(ref, impl("b"), "B");
    expect(r.version(ref)).toBeGreaterThan(first);
  });

  it("a stale remover of a dropped ref does not drop the recreated one", () => {
    const r = make();
    const off = r.provide(ref, impl("a"), "A");
    r.removeOwner("A");
    r.provide(ref, impl("b"), "B");
    off();
    expect(r.providerOf(ref)).toBe("B");
    expect(r.stats().refs).toBe(1);
  });
});

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

  it("plain methods keep their name and length too", () => {
    const r = make();
    const add = (a: number, b: number): number => a + b;
    const sref: ServiceRef<{ add: typeof add }> = { id: "adder", kind: "service" };
    r.provide(sref, { add }, "A");
    const wrapped = r.use(sref, "C", any).add;
    expect(wrapped.name).toBe("add");
    expect(wrapped.length).toBe(2);
    expect(() => new (wrapped as unknown as new () => unknown)()).toThrow(TypeError);
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
