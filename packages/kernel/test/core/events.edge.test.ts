import { describe, expect, it } from "vitest";
import { createEventBus } from "../../src/core/events.js";
import type { LoomError } from "../../src/core/errors.js";

function setup() {
  const errors: LoomError[] = [];
  const bus = createEventBus({
    onError: (e) => {
      errors.push(e);
    },
  });
  return { bus, errors };
}

describe("event bus edge cases", () => {
  it("emit during on/off sees a stable snapshot of the list", () => {
    const { bus } = setup();
    const seen: string[] = [];
    let offB = (): void => undefined;
    bus.on("t", "a", () => {
      seen.push("a");
      offB();
      bus.on("t", "late", () => void seen.push("late"));
    });
    offB = bus.on("t", "b", () => void seen.push("b"));
    bus.on("t", "c", () => void seen.push("c"));
    bus.emit("t", 0);
    // b was removed before its turn (skipped); the listener added mid-emit waits for the next emit
    expect(seen).toEqual(["a", "c"]);
    seen.length = 0;
    bus.emit("t", 0);
    expect(seen).toEqual(["a", "c", "late"]);
  });

  it("a reentrant emit of the same type delivers to every listener and the outer emit continues", () => {
    const { bus } = setup();
    const seen: string[] = [];
    let depth = 0;
    bus.on<number>("t", "a", (n) => {
      seen.push(`a${String(n)}`);
      if (depth++ === 0) bus.emit("t", 2);
    });
    bus.on<number>("t", "b", (n) => void seen.push(`b${String(n)}`));
    bus.emit("t", 1);
    expect(seen).toEqual(["a1", "a2", "b2", "b1"]);
  });

  it("a subscription made while a nested emit is running does not disturb the outer snapshot", () => {
    const { bus } = setup();
    const seen: string[] = [];
    let done = false;
    bus.on("t", "a", () => {
      seen.push("a");
      if (!done) {
        done = true;
        bus.emit("t", 0);
      }
    });
    bus.on("t", "b", () => {
      seen.push("b");
      bus.on("t", "n", () => void seen.push("n"));
    });
    bus.emit("t", 0);
    expect(seen).toEqual(["a", "a", "b", "b"]);
  });

  it("reports a non-Error throw from a listener as TAP_FAILED with the raw cause and the event type", () => {
    const { bus, errors } = setup();
    bus.on("kind", "p", () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the point of the test
      throw "plain string";
    });
    bus.emit("kind", 1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("TAP_FAILED");
    expect(errors[0]?.cause).toBe("plain string");
    expect(errors[0]?.pluginIds).toEqual(["p"]);
    expect(errors[0]?.details).toEqual({ type: "kind" });
  });

});

describe("event bus edge cases: removal", () => {
  it("removing the last listener of a type, then subscribing again, works", () => {
    const { bus } = setup();
    let n = 0;
    bus.on("t", "p", () => {
      n++;
    })();
    bus.emit("t", 0);
    expect(n).toBe(0);
    bus.on("t", "q", () => {
      n++;
    });
    bus.emit("t", 0);
    expect(n).toBe(1);
  });

  it("an owner removed mid-emit stops receiving, and later subscriptions append in order", () => {
    const { bus } = setup();
    const seen: string[] = [];
    bus.on("t", "a", () => {
      seen.push("a");
      bus.removeOwner("b");
    });
    bus.on("t", "b", () => void seen.push("b"));
    bus.emit("t", 0);
    bus.on("t", "c", () => void seen.push("c"));
    bus.emit("t", 0);
    expect(seen).toEqual(["a", "a", "c"]);
  });
});
