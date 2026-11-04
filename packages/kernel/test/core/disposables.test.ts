import { describe, expect, it } from "vitest";
import { DisposableStore } from "../../src/core/disposables.js";

describe("DisposableStore", () => {
  it("disposes in reverse order of add, awaiting async disposers", async () => {
    const store = new DisposableStore();
    const order: number[] = [];
    store.add(() => void order.push(1));
    store.add(async () => {
      await Promise.resolve();
      order.push(2);
    });
    store.add(() => void order.push(3));
    await store.dispose();
    expect(order).toEqual([3, 2, 1]);
    expect(store.disposed).toBe(true);
  });

  it("collects errors from all disposers and rethrows one AggregateError after running every disposer", async () => {
    const store = new DisposableStore();
    const ran: string[] = [];
    const e1 = new Error("e1");
    const e2 = new Error("e2");
    store.add(() => {
      ran.push("a");
      throw e1;
    });
    store.add(() => void ran.push("b"));
    store.add(() => {
      ran.push("c");
      return Promise.reject(e2);
    });
    const error = await store.dispose().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([e2, e1]);
    expect(ran).toEqual(["c", "b", "a"]);
  });

  it("add after dispose runs the disposer immediately", async () => {
    const store = new DisposableStore();
    await store.dispose();
    let ran = false;
    const remove = store.add(() => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(remove).not.toThrow();
  });

  it("returned remover prevents that disposer from running", async () => {
    const store = new DisposableStore();
    let ran = false;
    const remove = store.add(() => {
      ran = true;
    });
    remove();
    remove();
    await store.dispose();
    expect(ran).toBe(false);
  });

  it("dispose is idempotent", async () => {
    const store = new DisposableStore();
    let count = 0;
    store.add(() => {
      count++;
    });
    await store.dispose();
    await store.dispose();
    expect(count).toBe(1);
  });
});
