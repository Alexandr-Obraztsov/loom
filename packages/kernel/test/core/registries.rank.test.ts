import { describe, expect, it } from "vitest";

import { createHook, createServiceRef } from "../../src/core/definitions.js";
import { createEventBus } from "../../src/core/events.js";
import { createHookRegistry } from "../../src/core/hooks.js";
import { createServiceRegistry } from "../../src/core/services.js";

const ranks = new Map<string, number>();
const rankOf = (owner: string): number => ranks.get(owner) ?? 99;
const setRanks = (...owners: string[]): void => {
  ranks.clear();
  owners.forEach((o, i) => ranks.set(o, i));
};
const chain = createHook<string[], string[]>("rank.chain", { mode: "sync" });
interface Named {
  name(): string;
}
const named = createServiceRef<Named>("rank.named");

describe("hook registry rankOf", () => {
  it("breaks priority ties by owner rank, then registration; priority and constraints still win", () => {
    setRanks("y", "x", "w");
    const reg = createHookRegistry({ onError: () => undefined, rankOf });
    const tap = (owner: string, priority = 0, before: string[] = []): void => {
      reg.tap(chain, { owner, priority, before }, (l, next) => next([...l, owner]));
    };
    tap("x");
    tap("y");
    tap("x");
    tap("hi", 5);
    tap("w", 0, ["y"]);
    expect(reg.run(chain, [], (l) => l)).toEqual(["hi", "x", "x", "w", "y"]);
  });

  it("reorder applies changed ranks", () => {
    setRanks("a", "b");
    const reg = createHookRegistry({ onError: () => undefined, rankOf });
    reg.tap(chain, { owner: "b" }, (l, next) => next([...l, "b"]));
    reg.tap(chain, { owner: "a" }, (l, next) => next([...l, "a"]));
    expect(reg.taps(chain).map((t) => t.owner)).toEqual(["a", "b"]);
    setRanks("b", "a");
    expect(reg.taps(chain).map((t) => t.owner)).toEqual(["a", "b"]);
    reg.reorder();
    expect(reg.taps(chain).map((t) => t.owner)).toEqual(["b", "a"]);
  });

  it("without rankOf, ties keep registration order", () => {
    const reg = createHookRegistry({ onError: () => undefined });
    reg.tap(chain, { owner: "b" }, (l, next) => next([...l, "b"]));
    reg.tap(chain, { owner: "a" }, (l, next) => next([...l, "a"]));
    reg.reorder();
    expect(reg.run(chain, [], (l) => l)).toEqual(["b", "a"]);
  });
});

describe("event bus rankOf", () => {
  it("delivers by owner rank, then subscription order; reorder applies changed ranks", () => {
    setRanks("a", "b");
    const bus = createEventBus({ onError: () => undefined, rankOf });
    const heard: string[] = [];
    bus.on("e", "b", () => heard.push("b1"));
    bus.on("e", "a", () => heard.push("a"));
    bus.on("e", "b", () => heard.push("b2"));
    bus.emit("e", 0);
    expect(heard).toEqual(["a", "b1", "b2"]);
    setRanks("b", "a");
    bus.reorder();
    heard.length = 0;
    bus.emit("e", 0);
    expect(heard).toEqual(["b1", "b2", "a"]);
  });

  it("without rankOf, delivery keeps subscription order", () => {
    const bus = createEventBus({ onError: () => undefined });
    const heard: string[] = [];
    bus.on("e", "b", () => heard.push("b"));
    bus.on("e", "a", () => heard.push("a"));
    bus.reorder();
    bus.emit("e", 0);
    expect(heard).toEqual(["b", "a"]);
  });
});

describe("service registry rankOf", () => {
  const deco = (tag: string) => (prev: Named): Named => ({ name: () => prev.name() + tag });

  it("applies decorators by owner rank; reorder re-sorts, bumps the version and changes output", () => {
    setRanks("p", "a", "b");
    const reg = createServiceRegistry({ kernelOwner: "kernel", rankOf });
    reg.provide(named, { name: () => "p" }, "p");
    reg.decorate(named, deco("B"), "b");
    reg.decorate(named, deco("A"), "a");
    reg.decorate(named, deco("a"), "a");
    const svc = reg.use(named, "c", new Set(["p"]));
    expect(svc.name()).toBe("pAaB");
    const version = reg.version(named);
    reg.reorder();
    expect(reg.version(named)).toBe(version);
    setRanks("p", "b", "a");
    reg.reorder();
    expect(reg.version(named)).toBe(version + 1);
    expect(svc.name()).toBe("pBAa");
  });

  it("orders fallback providers by rank when the winner is absent", () => {
    setRanks("a", "b");
    const reg = createServiceRegistry({ kernelOwner: "kernel", rankOf, winners: { [named.id]: "z" } });
    reg.provide(named, { name: () => "b" }, "b");
    reg.provide(named, { name: () => "a" }, "a");
    expect(reg.providerOf(named)).toBe("a");
  });

  it("without rankOf, decorators keep registration order", () => {
    const reg = createServiceRegistry({ kernelOwner: "kernel" });
    reg.provide(named, { name: () => "p" }, "p");
    reg.decorate(named, deco("B"), "b");
    reg.decorate(named, deco("A"), "a");
    reg.reorder();
    expect(reg.use(named, "c", new Set(["p"])).name()).toBe("pBA");
  });
});
