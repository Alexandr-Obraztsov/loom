import { RequestError } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HANDSHAKE_TIMEOUT_MS } from "../src/main/sessions.js";
import type { Rig } from "./helpers.js";
import { only, OPEN, open, rig, tick } from "./helpers.js";
import { itemsOf } from "./helpers.js";

let r: Rig;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  r = rig();
});
afterEach(async () => {
  await r.sessions.dispose();
  vi.useRealTimers();
});

const never = (): Promise<void> => new Promise(() => undefined);

describe("agent start", () => {
  it("agent that never answers initialize fails ensure after 30 s", async () => {
    r.agent.initGate = never();
    const p = r.sessions.ensure(OPEN);
    const rejected = expect(p).rejects.toMatchObject({
      code: "AGENT_START_FAILED",
      message: expect.stringContaining("не ответил за 30 с") as unknown,
    });
    await tick(HANDSHAKE_TIMEOUT_MS - 1);
    expect(only(r.agent.links).killed).toBe(0);
    await tick(1);
    await rejected;
    expect(only(r.agent.links).killed).toBe(1);
  });

  it("dispose while the handshake never completes kills the agent", async () => {
    r.agent.initGate = never();
    const p = r.sessions.ensure(OPEN);
    const rejected = expect(p).rejects.toMatchObject({ code: "AGENT_START_FAILED" });
    await tick(0);
    await r.sessions.dispose();
    await rejected;
    expect(only(r.agent.links).killed).toBeGreaterThanOrEqual(1);
  });

  it("a restart inside prompt that hangs rejects the prompt and busy returns to false", async () => {
    const id = await open(r);
    only(r.agent.links).crash(1, "");
    await tick();
    r.agent.initGate = never();
    const turn = r.sessions.prompt(id, "x");
    const rejected = expect(turn).rejects.toMatchObject({ code: "AGENT_START_FAILED" });
    await tick(HANDSHAKE_TIMEOUT_MS);
    await rejected;
    await tick();
    const snap = await r.sessions.waitUpdates(id, 0, 1);
    expect(snap.busy).toBe(false);
    expect(itemsOf(snap.items, "error").length).toBeGreaterThan(0);
  });

  it("busy is true while the agent restarts inside prompt", async () => {
    const id = await open(r);
    only(r.agent.links).crash(1, "");
    await tick();
    let release!: () => void;
    r.agent.initGate = new Promise((res) => {
      release = res;
    });
    const turn = r.sessions.prompt(id, "x");
    await tick();
    expect((await r.sessions.waitUpdates(id, 0, 1)).busy).toBe(true);
    release();
    await turn;
    await tick();
    expect((await r.sessions.waitUpdates(id, 0, 1)).busy).toBe(false);
  });
});

describe("agent errors", () => {
  it("keeps structured agent error data and tolerates errors without data", async () => {
    const id = await open(r);
    r.agent.promptError = new RequestError(-32000, "bad", { x: 1 });
    await expect(r.sessions.prompt(id, "x")).rejects.toThrow(/bad: \{"x":1\}/);
    r.agent.promptError = new RequestError(-32001, "nodata");
    await expect(r.sessions.prompt(id, "y")).rejects.toThrow("nodata");
    await tick();
    const msgs = itemsOf((await r.sessions.waitUpdates(id, 0, 1)).items, "error").map(
      (e) => e.message,
    );
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toBe("nodata");
  });
});

describe("batching", () => {
  it("200 chunks within one batch bump seq once", async () => {
    const id = await open(r);
    const before = (await r.sessions.waitUpdates(id, -1, 1)).seq;
    r.agent.script = async (t) => {
      for (let i = 0; i < 200; i++) await t.say("x");
      return "end_turn";
    };
    await r.sessions.prompt(id, "long");
    await tick();
    const snap = await r.sessions.waitUpdates(id, 0, 1);
    expect(snap.seq).toBe(before + 1);
    expect(only(itemsOf(snap.items, "agent")).text).toBe("x".repeat(200));
  });
});
