import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ask, itemsOf, only, open, rig, tick } from "./helpers.js";
import type { Rig } from "./helpers.js";

let r: Rig;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  r = rig();
});
afterEach(async () => {
  await r.sessions.dispose();
  vi.useRealTimers();
});

describe("permission decisions", () => {
  it("ToolCallHook allow skips the user; null cancels", async () => {
    let decision: unknown = { optionId: "allow" };
    const k = rig({ "acp.toolCall": () => Promise.resolve(decision) });
    const id = await open(k);
    const outcomes: unknown[] = [];
    k.agent.script = async (t) => {
      outcomes.push((await ask(t)).outcome);
      return "end_turn";
    };
    await k.sessions.prompt(id, "x");
    decision = null;
    await k.sessions.prompt(id, "y");
    await tick();
    expect(outcomes).toEqual([
      { outcome: "selected", optionId: "allow" },
      { outcome: "cancelled" },
    ]);
    expect(itemsOf((await k.sessions.waitUpdates(id, 0, 1)).items, "permission")).toEqual([]);
    await k.sessions.dispose();
  });

  it("cancel ends the turn and resolves pending permissions as cancelled", async () => {
    const id = await open(r);
    let outcome: unknown;
    r.agent.script = async (t) => {
      outcome = (await ask(t)).outcome;
      await t.cancelled;
      return "cancelled";
    };
    const turn = r.sessions.prompt(id, "x");
    await tick();
    await r.sessions.cancel(id);
    await turn;
    await tick();
    expect(outcome).toEqual({ outcome: "cancelled" });
    const snap = await r.sessions.waitUpdates(id, 0, 1);
    expect(only(itemsOf(snap.items, "permission")).resolved).toBe("cancelled");
    expect(snap.busy).toBe(false);
  });
});
