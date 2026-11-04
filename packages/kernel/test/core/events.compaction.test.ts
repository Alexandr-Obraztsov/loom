import { describe, expect, it } from "vitest";
import { createEventBus } from "../../src/core/events.js";

describe("event bus bookkeeping", () => {
  it("delivers in rank order through removals, compaction and new subscriptions", () => {
    const ranks: Record<string, number> = {};
    const bus = createEventBus({ onError: () => undefined, rankOf: (o) => ranks[o] ?? 99 });
    const seen: string[] = [];
    const offs: (() => void)[] = [];
    for (let i = 0; i < 10; i++) {
      ranks[`p${String(i)}`] = 9 - i;
      offs.push(bus.on("t", `p${String(i)}`, () => void seen.push(`p${String(i)}`)));
    }
    bus.emit("t", 0);
    expect(seen).toEqual(["p9", "p8", "p7", "p6", "p5", "p4", "p3", "p2", "p1", "p0"]);
    for (const i of [0, 2, 4, 6]) bus.removeOwner(`p${String(i)}`);
    offs[1]?.();
    offs[0]?.();
    ranks.late = 5;
    bus.on("t", "late", () => void seen.push("late"));
    seen.length = 0;
    bus.emit("t", 0);
    expect(seen).toEqual(["p9", "p8", "p7", "p5", "late", "p3"]);
    for (const i of [3, 5, 7, 8, 9]) offs[i]?.();
    bus.removeOwner("late");
    seen.length = 0;
    bus.emit("t", 0);
    expect(seen).toEqual([]);
  });

  it("reorder skips removed entries and an unranked bus keeps subscription order", () => {
    const ranks: Record<string, number> = { a: 0, b: 1, c: 2 };
    const bus = createEventBus({ onError: () => undefined, rankOf: (o) => ranks[o] ?? 0 });
    const seen: string[] = [];
    for (const o of ["a", "b", "c"]) bus.on("t", o, () => void seen.push(o));
    bus.removeOwner("b");
    ranks.a = 5;
    bus.reorder();
    bus.emit("t", 0);
    expect(seen).toEqual(["c", "a"]);
    const plain = createEventBus({ onError: () => undefined });
    const order: string[] = [];
    for (const o of ["z", "y"]) plain.on("t", o, () => void order.push(o));
    plain.reorder();
    plain.emit("t", 0);
    expect(order).toEqual(["z", "y"]);
  });
});
