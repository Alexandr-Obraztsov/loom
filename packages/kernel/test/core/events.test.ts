import { describe, expect, it } from "vitest";

import { LoomError } from "../../src/core/errors.js";
import { createEventBus } from "../../src/core/events.js";

function setup() {
  const errors: LoomError[] = [];
  const bus = createEventBus({
    onError: (e) => {
      errors.push(e);
    },
  });
  return { bus, errors };
}

describe("event bus", () => {
  it("delivers synchronously in subscription order", () => {
    const { bus } = setup();
    const seen: string[] = [];
    bus.on<number>("a", "p1", (n) => {
      seen.push(`1:${String(n)}`);
    });
    bus.on<number>("a", "p2", (n) => {
      seen.push(`2:${String(n)}`);
    });
    bus.emit("a", 7);
    expect(seen).toEqual(["1:7", "2:7"]);
  });

  it("emit with no listeners is a no-op", () => {
    const { bus, errors } = setup();
    expect(() => {
      bus.emit("none", 1);
    }).not.toThrow();
    expect(errors).toEqual([]);
  });

  it("does not deliver other event types", () => {
    const { bus } = setup();
    let n = 0;
    bus.on("a", "p", () => {
      n++;
    });
    bus.emit("b", 1);
    expect(n).toBe(0);
  });

  it("reports a throwing listener as TAP_FAILED and continues", () => {
    const { bus, errors } = setup();
    const boom = new Error("boom");
    let wasReached = false;
    bus.on("a", "bad", () => {
      throw boom;
    });
    bus.on("a", "ok", () => {
      wasReached = true;
    });
    bus.emit("a", 1);
    expect(wasReached).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("TAP_FAILED");
    expect(errors[0]?.pluginIds).toEqual(["bad"]);
    expect(errors[0]?.cause).toBe(boom);
  });
});

describe("event bus error propagation", () => {
  it("rethrows a single onError failure after delivering to all", () => {
    const sinkErr = new Error("sink");
    const bus = createEventBus({
      onError: () => {
        throw sinkErr;
      },
    });
    let wasReached = false;
    bus.on("a", "bad", () => {
      throw new Error("x");
    });
    bus.on("a", "ok", () => {
      wasReached = true;
    });
    expect(() => {
      bus.emit("a", 1);
    }).toThrow(sinkErr);
    expect(wasReached).toBe(true);
  });

  it("rethrows several onError failures as AggregateError", () => {
    const bus = createEventBus({
      onError: () => {
        throw new Error("sink");
      },
    });
    for (const o of ["x", "y"]) {
      bus.on("a", o, () => {
        throw new Error("l");
      });
    }
    let caught: unknown;
    try {
      bus.emit("a", 1);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toHaveLength(2);
  });
});

describe("event bus snapshots and removal", () => {
  it("does not call listeners added during emit for that emit", () => {
    const { bus } = setup();
    const seen: string[] = [];
    bus.on("a", "p", () => {
      seen.push("first");
      bus.on("a", "p", () => {
        seen.push("late");
      });
    });
    bus.emit("a", 1);
    expect(seen).toEqual(["first"]);
    bus.emit("a", 1);
    expect(seen).toEqual(["first", "first", "late"]);
  });

  it("does not call a listener removed during emit before it is reached", () => {
    const { bus } = setup();
    const seen: string[] = [];
    let off2 = (): void => undefined;
    bus.on("a", "p", () => {
      seen.push("1");
      off2();
    });
    off2 = bus.on("a", "q", () => {
      seen.push("2");
    });
    bus.on("a", "r", () => {
      seen.push("3");
    });
    bus.emit("a", 1);
    expect(seen).toEqual(["1", "3"]);
  });

  it("does not call listeners of an owner removed during emit", () => {
    const { bus } = setup();
    const seen: string[] = [];
    bus.on("a", "p", () => {
      seen.push("1");
      bus.removeOwner("q");
    });
    bus.on("a", "q", () => {
      seen.push("2");
    });
    bus.emit("a", 1);
    expect(seen).toEqual(["1"]);
  });
});

describe("event bus subscriptions", () => {
  it("remover is idempotent and removes only its own subscription", () => {
    const { bus } = setup();
    let n = 0;
    const l = (): void => {
      n++;
    };
    const off1 = bus.on("a", "p", l);
    bus.on("a", "p", l);
    off1();
    off1();
    bus.emit("a", 1);
    expect(n).toBe(1);
  });

  it("the same function subscribed twice is called twice", () => {
    const { bus } = setup();
    let n = 0;
    const l = (): void => {
      n++;
    };
    bus.on("a", "p", l);
    bus.on("a", "p", l);
    bus.emit("a", 1);
    expect(n).toBe(2);
  });

  it("removeOwner removes only that owner's listeners", () => {
    const { bus } = setup();
    const seen: string[] = [];
    bus.on("a", "p", () => {
      seen.push("p");
    });
    bus.on("b", "p", () => {
      seen.push("p-b");
    });
    bus.on("a", "q", () => {
      seen.push("q");
    });
    bus.removeOwner("p");
    bus.emit("a", 1);
    bus.emit("b", 1);
    expect(seen).toEqual(["q"]);
  });

  it("remover after removeOwner is harmless", () => {
    const { bus } = setup();
    const off = bus.on("a", "p", () => undefined);
    bus.removeOwner("p");
    expect(() => {
      off();
    }).not.toThrow();
  });
});
