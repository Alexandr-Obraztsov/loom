import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Rig } from "./helpers.js";
import { ask, itemsOf, only, open, rig, tick } from "./helpers.js";

let r: Rig;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  r = rig();
});
afterEach(async () => {
  await r.sessions.dispose();
  vi.useRealTimers();
});

describe("permissions", () => {
  it("undecided by hooks appears as an item and resolves via respondPermission", async () => {
    const id = await open(r);
    let outcome: unknown;
    r.agent.script = async (t) => {
      outcome = (await ask(t)).outcome;
      return "end_turn";
    };
    const turn = r.sessions.prompt(id, "x");
    await tick();
    const item = only(itemsOf((await r.sessions.waitUpdates(id, 0, 1)).items, "permission"));
    expect(item.title).toBe("Run ls");
    expect(item.options.map((o) => o.optionId)).toEqual(["allow", "no"]);
    await r.sessions.respondPermission(id, item.id, "allow");
    await r.sessions.respondPermission(id, item.id, "no");
    await r.sessions.respondPermission(id, "ghost", null);
    await turn;
    await tick();
    expect(outcome).toEqual({ outcome: "selected", optionId: "allow" });
    expect(
      only(itemsOf((await r.sessions.waitUpdates(id, 0, 1)).items, "permission")).resolved,
    ).toBe("allow");
  });

  it("requested while nobody waits is returned by the next waitUpdates", async () => {
    const id = await open(r);
    r.agent.script = async (t) => {
      await ask(t);
      return "end_turn";
    };
    const seq0 = (await r.sessions.waitUpdates(id, -1, 1)).seq;
    let isTurnDone = false;
    void r.sessions.prompt(id, "x").then(() => (isTurnDone = true));
    await tick(200); // no poller during this time
    const snap = await r.sessions.waitUpdates(id, seq0, 60000);
    const item = only(itemsOf(snap.items, "permission"));
    expect(isTurnDone).toBe(false);
    await r.sessions.respondPermission(id, item.id, null);
    await tick();
    expect(isTurnDone).toBe(true);
  });
});
