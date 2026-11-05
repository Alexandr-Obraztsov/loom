import { describe, expect, it, vi } from "vitest";
import { LoomError } from "../../src/core/errors.js";
import { createServiceRegistry } from "../../src/core/services.js";
import type { ServiceRef } from "../../src/core/types.js";

interface Greeter {
  greet(name: string): string;
}
const ref: ServiceRef<Greeter> = { id: "greeter", kind: "service" };
const any = new Set(["A", "B", "O", "X", "D"]);

function make(winners?: Record<string, string>, onError?: (e: unknown) => void) {
  return createServiceRegistry({
    kernelOwner: "kernel",
    ...(winners ? { winners } : {}),
    ...(onError ? { onError } : {}),
  });
}
const impl = (tag: string): Greeter => ({ greet: (n) => `${tag}:${n}` });
function codeOf(fn: () => unknown): LoomError {
  try {
    fn();
  } catch (e) {
    if (e instanceof LoomError) return e;
    throw e;
  }
  throw new Error("did not throw");
}

describe("service registry", () => {
  it("use returns provided impl methods", () => {
    const r = make();
    r.provide(ref, impl("a"), "A");
    expect(r.use(ref, "C", new Set(["A"])).greet("x")).toBe("a:x");
    expect(r.has(ref)).toBe(true);
    expect(r.providerOf(ref)).toBe("A");
  });

  it("second provide throws SERVICE_CONFLICT naming both owners", () => {
    const r = make();
    r.provide(ref, impl("a"), "A");
    const err = codeOf(() => r.provide(ref, impl("b"), "B"));
    expect(err.code).toBe("SERVICE_CONFLICT");
    expect(err.pluginIds).toEqual(["A", "B"]);
    expect(r.providerOf(ref)).toBe("A");
  });

  it("winners config activates the named provider and keeps the other as fallback", () => {
    const r = make({ greeter: "B" });
    r.provide(ref, impl("a"), "A");
    const rmB = r.provide(ref, impl("b"), "B");
    expect(r.providerOf(ref)).toBe("B");
    rmB();
    expect(r.providerOf(ref)).toBe("A");
  });

  it("winner that never registers leaves the first registration active", () => {
    const r = make({ greeter: "Z" });
    r.provide(ref, impl("a"), "A");
    r.provide(ref, impl("b"), "B");
    expect(r.providerOf(ref)).toBe("A");
  });

  it("override replaces provide, removing override restores provide", () => {
    const r = make();
    r.provide(ref, impl("a"), "A");
    const rm = r.override(ref, impl("o"), "O");
    const p = r.use(ref, "kernel", any);
    expect(p.greet("x")).toBe("o:x");
    rm();
    rm();
    expect(p.greet("x")).toBe("a:x");
  });

  it("two overrides without winner throw SERVICE_CONFLICT", () => {
    const r = make();
    r.override(ref, impl("o1"), "O1");
    const err = codeOf(() => r.override(ref, impl("o2"), "O2"));
    expect(err.code).toBe("SERVICE_CONFLICT");
    expect(err.pluginIds).toEqual(["O1", "O2"]);
  });

  it("two overrides with winner pick the winner", () => {
    const r = make({ greeter: "O2" });
    r.override(ref, impl("o1"), "O1");
    r.override(ref, impl("o2"), "O2");
    expect(r.providerOf(ref)).toBe("O2");
  });

  it("decorators stack in order and wrap the current impl", () => {
    const r = make();
    r.provide(ref, impl("a"), "A");
    const wrap =
      (t: string) =>
      (prev: Greeter): Greeter => ({ greet: (n) => `${t}(${prev.greet(n)})` });
    r.decorate(ref, wrap("d1"), "D1");
    const rm2 = r.decorate(ref, wrap("d2"), "D2");
    const p = r.use(ref, "kernel", any);
    expect(p.greet("x")).toBe("d2(d1(a:x))");
    rm2();
    expect(p.greet("x")).toBe("d1(a:x)");
  });

  it("decorator registered before provider applies once provided", () => {
    const r = make();
    r.decorate(ref, (prev) => ({ greet: (n) => `d(${prev.greet(n)})` }), "D");
    expect(r.has(ref)).toBe(false);
    r.provide(ref, impl("a"), "A");
    expect(r.use(ref, "kernel", any).greet("x")).toBe("d(a:x)");
  });
});

describe("service registry: live proxies", () => {
  it("proxy obtained before override calls the override", () => {
    const r = make();
    r.provide(ref, impl("a"), "A");
    const p = r.use(ref, "kernel", any);
    expect(p.greet("x")).toBe("a:x");
    r.override(ref, impl("o"), "O");
    expect(p.greet("x")).toBe("o:x");
  });

  it("use returns the same proxy for the same ref and consumer", () => {
    const r = make();
    r.provide(ref, impl("a"), "A");
    expect(r.use(ref, "C", new Set(["A"]))).toBe(r.use(ref, "C", new Set(["A"])));
    expect(r.use(ref, "C", new Set(["A"]))).not.toBe(r.use(ref, "D", new Set(["A"])));
  });

  it("proxy call after provider removed throws SERVICE_MISSING", () => {
    const r = make();
    const rm = r.provide(ref, impl("a"), "A");
    const p = r.use(ref, "C", new Set(["A"]));
    rm();
    const err = codeOf(() => p.greet("x"));
    expect(err.code).toBe("SERVICE_MISSING");
    expect(err.pluginIds).toEqual(["C"]);
    expect(err.details).toEqual({ ref: "greeter" });
    expect(codeOf(() => "greet" in p).code).toBe("SERVICE_MISSING");
  });

  it("use before any provider returns a proxy that works once provided", () => {
    const r = make();
    const p = r.use(ref, "C", new Set(["A"]));
    r.provide(ref, impl("a"), "A");
    expect(p.greet("x")).toBe("a:x");
  });
});

describe("service registry: access and removeOwner", () => {
  it("use of service whose provider is not in allowed throws UNDECLARED_DEPENDENCY", () => {
    const r = make();
    r.provide(ref, impl("a"), "A");
    const err = codeOf(() => r.use(ref, "C", new Set()));
    expect(err.code).toBe("UNDECLARED_DEPENDENCY");
    expect(err.pluginIds).toEqual(["C"]);
  });

  it("allowed check runs again when the active provider changes", () => {
    const r = make();
    r.provide(ref, impl("a"), "A");
    const p = r.use(ref, "C", new Set(["A"]));
    expect(p.greet("x")).toBe("a:x");
    r.override(ref, impl("o"), "O");
    expect(codeOf(() => p.greet("x")).code).toBe("UNDECLARED_DEPENDENCY");
  });

  it("consumer's own services are usable", () => {
    const r = make();
    r.provide(ref, impl("a"), "C");
    expect(r.use(ref, "C", new Set()).greet("x")).toBe("a:x");
  });

  it("kernel-owned services are usable by anyone", () => {
    const r = make();
    r.provide(ref, impl("k"), "kernel");
    expect(r.use(ref, "C", new Set()).greet("x")).toBe("k:x");
  });

  it("removeOwner drops provides, overrides and decorators of that owner", () => {
    const r = make();
    r.provide(ref, impl("a"), "A");
    r.override(ref, impl("x"), "X");
    r.decorate(ref, (p) => ({ greet: (n) => `x(${p.greet(n)})` }), "X");
    const p = r.use(ref, "kernel", any);
    expect(p.greet("n")).toBe("x(x:n)");
    r.removeOwner("X");
    expect(p.greet("n")).toBe("a:n");
    r.removeOwner("A");
    expect(r.has(ref)).toBe(false);
    r.removeOwner("nobody");
  });
});

describe("service registry: onChange", () => {
  it("onChange fires with ref id on every change of the active implementation", () => {
    const r = make();
    const seen: string[] = [];
    const off = r.onChange((id) => seen.push(id));
    const rm = r.provide(ref, impl("a"), "A");
    r.override(ref, impl("o"), "O");
    const rd = r.decorate(ref, (p) => p, "D");
    rd();
    rm(); // the override is active, so removing the provider changes nothing
    expect(seen).toEqual(["greeter", "greeter", "greeter", "greeter"]);
    off();
    r.provide(ref, impl("b"), "B");
    expect(seen).toHaveLength(4);
  });

  it("rejected registration does not fire onChange", () => {
    const r = make();
    r.provide(ref, impl("a"), "A");
    const spy = vi.fn();
    r.onChange(spy);
    expect(() => r.provide(ref, impl("b"), "B")).toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it("listener errors go to onError as TAP_FAILED and do not stop other listeners", () => {
    const errors: unknown[] = [];
    const r = make(undefined, (e) => errors.push(e));
    const boom = new Error("boom");
    const after = vi.fn();
    r.onChange(() => {
      throw boom;
    });
    r.onChange(after);
    r.provide(ref, impl("a"), "A");
    expect(r.providerOf(ref)).toBe("A");
    expect(after).toHaveBeenCalledOnce();
    const err = errors[0] as LoomError;
    expect(err.code).toBe("TAP_FAILED");
    expect(err.pluginIds).toEqual([]);
    expect(err.cause).toBe(boom);
  });

  it("without onError a listener error is thrown after all listeners ran", () => {
    const r = make();
    const after = vi.fn();
    r.onChange(() => {
      throw new Error("boom");
    });
    r.onChange(after);
    expect(codeOf(() => r.provide(ref, impl("a"), "A")).code).toBe("TAP_FAILED");
    expect(after).toHaveBeenCalledOnce();
    expect(r.providerOf(ref)).toBe("A");
  });
});

describe("service registry: proxy forwarding", () => {
  it("methods are bound: destructured method keeps this", () => {
    const r = make();
    class Counter {
      n = 0;
      inc(): number {
        return ++this.n;
      }
    }
    const cref: ServiceRef<Counter> = { id: "counter", kind: "service" };
    r.provide(cref, new Counter(), "A");
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the point of the test
    const { inc } = r.use(cref, "kernel", any);
    expect(inc()).toBe(1);
    expect(inc()).toBe(2);
    const p = r.use(cref, "kernel", any);
    expect(Reflect.get(p, "inc")).toBe(Reflect.get(p, "inc"));
    expect(p.n).toBe(2);
  });

  it("bound function identity changes after a change", () => {
    const r = make();
    r.provide(ref, impl("a"), "A");
    const p = r.use(ref, "kernel", any);
    const before: unknown = Reflect.get(p, "greet");
    r.override(ref, impl("o"), "O");
    expect(Reflect.get(p, "greet")).not.toBe(before);
  });

  it("forwards has, ownKeys and descriptors; rejects writes", () => {
    const r = make();
    r.provide(ref, impl("a"), "A");
    const p = r.use(ref, "kernel", any);
    expect("greet" in p).toBe(true);
    expect("nope" in p).toBe(false);
    expect(Object.keys(p)).toEqual(["greet"]);
    expect(Object.getOwnPropertyDescriptor(p, "greet")?.configurable).toBe(true);
    expect(Object.getOwnPropertyDescriptor(p, "nope")).toBeUndefined();
    expect(() => {
      (p as unknown as Record<string, unknown>)["x"] = 1;
    }).toThrow(TypeError);
    expect(() => Reflect.defineProperty(p, "x", { value: 1 })).toThrow(TypeError);
    expect(() => Reflect.deleteProperty(p, "greet")).toThrow(TypeError);
  });

  it("resolved impl is cached until a change (decorator fn runs once per change, not per call)", () => {
    const r = make();
    r.provide(ref, impl("a"), "A");
    const fn = vi.fn((prev: Greeter): Greeter => prev);
    r.decorate(ref, fn, "D");
    const p = r.use(ref, "kernel", any);
    p.greet("1");
    p.greet("2");
    p.greet("3");
    expect(fn).toHaveBeenCalledTimes(1);
    r.override(ref, impl("o"), "O");
    p.greet("4");
    p.greet("5");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("service registry owner bookkeeping", () => {
  it("removeOwner forgets the consumer's proxies and leaves refs it no longer holds untouched", () => {
    const r = make();
    const off = r.provide(ref, impl("a"), "A");
    const p = r.use(ref, "B", any);
    r.removeOwner("B");
    expect(r.use(ref, "B", any)).not.toBe(p);
    off();
    const v = r.version(ref);
    r.removeOwner("A");
    expect(r.version(ref)).toBe(v);
    r.provide(ref, impl("x"), "X");
    expect(r.use(ref, "B", any).greet("n")).toBe("x:n");
  });
});
