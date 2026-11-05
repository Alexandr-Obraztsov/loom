import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Rig } from "./helpers.js";
import { itemsOf, only, open, rig, tick } from "./helpers.js";

let r: Rig;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  r = rig();
});
afterEach(async () => {
  await r.sessions.dispose();
  vi.useRealTimers();
});

describe("agent exit", () => {
  it("shows an error item, rejects the turn, cancels permissions and restarts on the next prompt", async () => {
    const id = await open(r);
    let outcome: unknown;
    r.agent.script = async (t) => {
      outcome = (
        await t.client.request("session/request_permission", {
          sessionId: t.acpSessionId,
          toolCall: { toolCallId: "tc" },
          options: [],
        })
      ).outcome;
      return "end_turn";
    };
    const turn = r.sessions.prompt(id, "x");
    const rejected = expect(turn).rejects.toMatchObject({ code: "AGENT_EXITED" });
    await tick();
    only(r.agent.links).crash(1, "boom");
    await rejected;
    await tick();
    const snap = await r.sessions.waitUpdates(id, 0, 1);
    const err = only(itemsOf(snap.items, "error"));
    expect(err.stderr).toBe("boom");
    expect(err.message).toContain("код 1");
    expect(snap.busy).toBe(false);
    expect(only(itemsOf(snap.items, "permission")).resolved).toBe("cancelled");
    expect(outcome).toBeUndefined();

    await r.sessions.cancel(id); // dead agent: nothing to notify
    r.agent.script = (t) => t.say("again").then(() => "end_turn");
    await r.sessions.prompt(id, "retry");
    await tick();
    expect(r.agent.links).toHaveLength(2);
    expect(itemsOf((await r.sessions.waitUpdates(id, 0, 1)).items, "agent").at(-1)?.text).toBe(
      "again",
    );
  });

  it("a failed restart is shown as an error item with stderr", async () => {
    const id = await open(r);
    only(r.agent.links).crash(2, "");
    await tick();
    r.agent.initError = "still broken";
    await expect(r.sessions.prompt(id, "x")).rejects.toMatchObject({ code: "AGENT_START_FAILED" });
    await tick();
    expect(itemsOf((await r.sessions.waitUpdates(id, 0, 1)).items, "error")).toHaveLength(2);
  });
});
