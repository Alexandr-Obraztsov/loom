import { describe, expect, it } from "vitest";
import { createMemoryTransportPair, createRpcEndpoint } from "@loom/kernel";
import { createSwitchableEndpoint } from "../src/main/host-endpoint.js";

function pair(): {
  near: ReturnType<typeof createRpcEndpoint>;
  far: ReturnType<typeof createRpcEndpoint>;
} {
  const [a, b] = createMemoryTransportPair();
  return { near: createRpcEndpoint(a), far: createRpcEndpoint(b) };
}

describe("createSwitchableEndpoint", () => {
  it("rejects calls while no page is attached", async () => {
    const { endpoint } = createSwitchableEndpoint();
    await expect(endpoint.call("t", "m", [])).rejects.toMatchObject({ code: "RPC_DISCONNECTED" });
  });

  it("forwards calls to the attached page and stops after detach", async () => {
    const host = createSwitchableEndpoint();
    const { near, far } = pair();
    far.handle("t", (method, args) => Promise.resolve(`${method}:${String(args[0])}`));
    const detach = host.attach(near);
    expect(await host.endpoint.call("t", "m", [1])).toBe("m:1");
    detach();
    await expect(host.endpoint.call("t", "m", [1])).rejects.toMatchObject({
      code: "RPC_DISCONNECTED",
    });
  });

  it("serves handlers on every page attached, including ones registered earlier", async () => {
    const host = createSwitchableEndpoint();
    host.endpoint.handle("early", () => Promise.resolve("early"));
    const first = pair();
    const detach = host.attach(first.near);
    host.endpoint.handle("late", () => Promise.resolve("late"));
    expect(await first.far.call("early", "x", [])).toBe("early");
    expect(await first.far.call("late", "x", [])).toBe("late");
    detach();

    const second = pair();
    host.attach(second.near);
    expect(await second.far.call("early", "x", [])).toBe("early");
    expect(await second.far.call("late", "x", [])).toBe("late");
  });

  it("rejects a second handler for one target and lets a removed one be registered again", () => {
    const host = createSwitchableEndpoint();
    const remove = host.endpoint.handle("t", () => Promise.resolve(1));
    expect(() => host.endpoint.handle("t", () => Promise.resolve(2))).toThrow(
      /already has a handler/,
    );
    remove();
    expect(() => host.endpoint.handle("t", () => Promise.resolve(3))).not.toThrow();
    host.endpoint.close();
  });
});
