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

describe("service registry (stale provider safety)", () => {
  it("destructured method follows override", () => {
    const r = make();
    r.provide(ref, impl("a"), "A");
    const p = r.use(ref, "kernel", any);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the point of the test
    const { greet } = p;
    expect(greet("x")).toBe("a:x");
    r.override(ref, impl("o"), "O");
    expect(greet("x")).toBe("o:x");
  });

  it("destructured method throws SERVICE_MISSING after provider removed", () => {
    const r = make();
    const rm = r.provide(ref, impl("a"), "A");
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the point of the test
    const { greet } = r.use(ref, "C", new Set(["A"]));
    rm();
    expect(codeOf(() => greet("x")).code).toBe("SERVICE_MISSING");
  });

  it("destructured method throws UNDECLARED_DEPENDENCY when provider switches to a non-allowed owner", () => {
    const r = make();
    r.provide(ref, impl("a"), "A");
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the point of the test
    const { greet } = r.use(ref, "C", new Set(["A"]));
    r.override(ref, impl("o"), "O");
    expect(codeOf(() => greet("x")).code).toBe("UNDECLARED_DEPENDENCY");
  });
});

describe("service registry (proxy lifecycle and errors)", () => {
  const wrap = (prev: Greeter): Greeter => ({ greet: (n) => `d(${prev.greet(n)})` });

  it("use with a new allowed set is honoured by the returned proxy", () => {
    const r = make();
    r.provide(ref, impl("a"), "A");
    const p = r.use(ref, "C", new Set(["A"]));
    r.override(ref, impl("o"), "O");
    expect(() => p.greet("x")).toThrow();
    const again = r.use(ref, "C", new Set(["A", "O"]));
    expect(again).toBe(p);
    expect(p.greet("x")).toBe("o:x");
  });

  it("removeOwner(consumer) drops its cached proxies", () => {
    const r = make();
    r.provide(ref, impl("a"), "A");
    const p = r.use(ref, "C", new Set(["A"]));
    r.removeOwner("C");
    expect(r.use(ref, "C", new Set(["A"]))).not.toBe(p);
  });

  it("throwing decorator yields TAP_FAILED with its owner, runs once per version, has/providerOf unaffected", () => {
    const r = make();
    r.provide(ref, impl("a"), "A");
    const boom = new Error("boom");
    const fn = vi.fn((): Greeter => {
      throw boom;
    });
    r.decorate(ref, fn, "D");
    const p = r.use(ref, "kernel", any);
    const e1 = codeOf(() => p.greet("x"));
    expect(e1.code).toBe("TAP_FAILED");
    expect(e1.pluginIds).toEqual(["D"]);
    expect(e1.cause).toBe(boom);
    expect(codeOf(() => p.greet("y")).code).toBe("TAP_FAILED");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(r.has(ref)).toBe(true);
    expect(r.providerOf(ref)).toBe("A");
    r.decorate(ref, wrap, "E");
    expect(codeOf(() => p.greet("z")).code).toBe("TAP_FAILED");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("service registry (notifications)", () => {
  it("during removeOwner of two refs, a listener for one sees the other already updated", () => {
    const r = make();
    const refB: ServiceRef<Greeter> = { id: "b", kind: "service" };
    r.provide(ref, impl("a"), "X");
    r.provide(refB, impl("b"), "X");
    const seen: boolean[] = [];
    r.onChange((id) => {
      if (id === "greeter") seen.push(r.has(refB));
    });
    r.removeOwner("X");
    expect(seen).toEqual([false]);
  });

  it("two failing listeners without onError surface both errors", () => {
    const r = make();
    r.onChange(() => {
      throw new Error("1");
    });
    r.onChange(() => {
      throw new Error("2");
    });
    let caught: unknown;
    try {
      r.provide(ref, impl("a"), "A");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toHaveLength(2);
  });

  it("onError that throws does not stop delivery and is rethrown at the end", () => {
    const delivered: unknown[] = [];
    const r = make(undefined, (e) => {
      delivered.push(e);
      throw new Error("sink");
    });
    r.onChange(() => {
      throw new Error("1");
    });
    r.onChange(() => {
      throw new Error("2");
    });
    expect(() => r.provide(ref, impl("a"), "A")).toThrow(AggregateError);
    expect(delivered).toHaveLength(2);
  });

  it("single throwing onError is rethrown as is", () => {
    const r = make(undefined, () => {
      throw new Error("sink");
    });
    r.onChange(() => {
      throw new Error("1");
    });
    expect(() => r.provide(ref, impl("a"), "A")).toThrow("sink");
  });

  it("destructured method that became a non-function throws TypeError", () => {
    const r = make();
    const obj: { greet: unknown } = { greet: (n: string) => n };
    const mref: ServiceRef<{ greet: unknown }> = { id: "m", kind: "service" };
    r.provide(mref, obj, "A");
    const p = r.use(mref, "kernel", any);
    const fn = p.greet as () => unknown;
    obj.greet = 1;
    expect(fn).toThrow(TypeError);
  });
});
