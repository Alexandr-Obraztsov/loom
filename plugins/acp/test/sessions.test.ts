import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AcpError } from "../src/api.js";
import { createAgentRegistry } from "../src/main/registry.js";
import type { Rig } from "./helpers.js";
import { itemsOf, only, OPEN, open, rig, SPEC, tick } from "./helpers.js";

let r: Rig;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  r = rig();
});
afterEach(async () => {
  await r.sessions.dispose();
  vi.useRealTimers();
});

describe("registry", () => {
  it("add with an existing id replaces it and the remover restores nothing else", () => {
    const reg = createAgentRegistry();
    const removeA = reg.add({ ...SPEC, title: "A" });
    const removeB = reg.add({ ...SPEC, title: "B" });
    expect(reg.list().map((s) => s.title)).toEqual(["B"]);
    removeA();
    expect(reg.list().map((s) => s.title)).toEqual(["B"]);
    removeB();
    expect(reg.list()).toEqual([]);
  });
});

describe("ensure", () => {
  it("creates one session and is idempotent", async () => {
    const [a, b] = await Promise.all([r.sessions.ensure(OPEN), r.sessions.ensure(OPEN)]);
    const c = await r.sessions.ensure(OPEN);
    expect(a.sessionId).toBe(b.sessionId);
    expect(c.sessionId).toBe(a.sessionId);
    expect(r.agent.links).toHaveLength(1);
  });

  it("rejects an unknown agent", async () => {
    await expect(r.sessions.ensure({ agentId: "nope", cwd: "/" })).rejects.toMatchObject({
      code: "AGENT_UNKNOWN",
    });
  });

  it("fails with AGENT_START_FAILED when the handshake fails and kills the process", async () => {
    r.agent.initError = "no login";
    await expect(r.sessions.ensure(OPEN)).rejects.toMatchObject({ code: "AGENT_START_FAILED" });
    expect(only(r.agent.links).killed).toBe(1);
  });

  it("agent exiting during handshake rejects ensure with stderr", async () => {
    let release!: () => void;
    r.agent.initGate = new Promise((res) => (release = res));
    const p = r.sessions.ensure(OPEN);
    const rejected = expect(p).rejects.toThrow(/код 3[\s\S]*not logged in/);
    await tick(0);
    only(r.agent.links).crash(3, "not logged in");
    release();
    await rejected;
  });
});

describe("updates", () => {
  it("merges agent chunks into one agent item", async () => {
    const id = await open(r);
    r.agent.script = async (t) => {
      await t.say("a");
      await t.say("b");
      await t.update({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "hm" },
      });
      await t.update({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "m" },
      });
      await t.say("c");
      await t.update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", data: "", mimeType: "image/png" },
      });
      await t.update({
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "echo" },
      });
      return "end_turn";
    };
    await r.sessions.prompt(id, "hi");
    await tick();
    const snap = await r.sessions.waitUpdates(id, 0, 1);
    expect(snap.busy).toBe(false);
    expect(snap.items.map((i) => i.kind)).toEqual(["user", "agent", "thought", "agent", "user"]);
    expect(itemsOf(snap.items, "agent").map((i) => i.text)).toEqual(["ab", "c"]);
    expect(only(itemsOf(snap.items, "thought")).text).toBe("hmm");
  });

  it("a tool call and its updates upsert one tool item", async () => {
    const id = await open(r);
    r.agent.script = async (t) => {
      await t.update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "ls" });
      await t.update({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        content: [
          { type: "content", content: { type: "text", text: "out" } },
          { type: "content", content: { type: "image", data: "", mimeType: "image/png" } },
        ],
      });
      await t.update({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "in_progress",
      });
      await t.update({
        sessionUpdate: "tool_call_update",
        toolCallId: "t2",
        content: [{ type: "diff", path: "/a", newText: "b" }],
      });
      await t.update({ sessionUpdate: "plan", entries: [] });
      return "end_turn";
    };
    await r.sessions.prompt(id, "go");
    await tick();
    const tools = itemsOf((await r.sessions.waitUpdates(id, 0, 1)).items, "tool");
    expect(tools).toEqual([
      { kind: "tool", id: "t1", title: "ls", status: "in_progress", detail: "out" },
      { kind: "tool", id: "t2", title: "t2", status: "pending" },
    ]);
  });
});

describe("waitUpdates", () => {
  it("resolves after the timeout with the current snapshot", async () => {
    const id = await open(r);
    const seq = (await r.sessions.waitUpdates(id, -1, 1)).seq;
    const p = r.sessions.waitUpdates(id, seq, 1000);
    await tick(999);
    let isDone = false;
    void p.then(() => {
      isDone = true;
    });
    await tick(0);
    expect(isDone).toBe(false);
    await tick(1);
    expect((await p).seq).toBe(seq);
  });

  it("uses a 25 s default and keeps waiting when seq is still not above afterSeq", async () => {
    const id = await open(r);
    const p = r.sessions.waitUpdates(id, 99);
    await r.sessions.prompt(id, "noise"); // wakes nobody: seq stays below 99
    await tick();
    await tick(24999 - 16);
    let isDone = false;
    void p.then(() => {
      isDone = true;
    });
    await tick(0);
    expect(isDone).toBe(false);
    await tick(1);
    await p;
  });

  it("wakes when an update lands", async () => {
    const id = await open(r);
    const seq = (await r.sessions.waitUpdates(id, -1, 1)).seq;
    const p = r.sessions.waitUpdates(id, seq, 60000);
    r.agent.script = (t) => t.say("hey").then(() => "end_turn");
    void r.sessions.prompt(id, "x");
    await tick();
    expect((await p).seq).toBeGreaterThan(seq);
  });

  it("rejects an unknown session and releases waiters on close", async () => {
    await expect(r.sessions.waitUpdates("zzz", 0)).rejects.toMatchObject({
      code: "SESSION_UNKNOWN",
    });
    const id = await open(r);
    const p = r.sessions.waitUpdates(id, 50, 60000);
    await r.sessions.close(id);
    expect((await p).sessionId).toBe(id);
    expect(only(r.agent.links).killed).toBe(1);
    await expect(r.sessions.prompt(id, "x")).rejects.toBeInstanceOf(AcpError);
  });
});

describe("prompt", () => {
  it("rejects SESSION_BUSY while a turn runs", async () => {
    const id = await open(r);
    let finish!: () => void;
    r.agent.script = () =>
      new Promise((res) => {
        finish = () => {
          res("end_turn");
        };
      });
    const first = r.sessions.prompt(id, "one");
    await tick(0);
    await expect(r.sessions.prompt(id, "two")).rejects.toMatchObject({ code: "SESSION_BUSY" });
    await tick();
    expect((await r.sessions.waitUpdates(id, 0, 1)).busy).toBe(true);
    finish();
    await first;
    await tick();
    expect((await r.sessions.waitUpdates(id, 0, 1)).busy).toBe(false);
  });

  it("surfaces an agent error as an error item and rethrows", async () => {
    const id = await open(r);
    r.agent.promptError = "kaput";
    only(r.agent.links).stderr = "trace line";
    await expect(r.sessions.prompt(id, "x")).rejects.toThrow(/Internal error: kaput\ntrace line/);
    await tick();
    const err = only(itemsOf((await r.sessions.waitUpdates(id, 0, 1)).items, "error"));
    expect(err.message).toBe("Internal error: kaput");
    expect(err.stderr).toBe("trace line");
  });

  it("reports non-Error rejections", async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- non-Error rejection is the case under test
    const reject = Promise.reject("plain");
    reject.catch(() => undefined);
    const k = rig({ "acp.prompt": () => reject });
    const id = await open(k);
    await expect(k.sessions.prompt(id, "x")).rejects.toThrow("plain");
    await tick();
    expect(only(itemsOf((await k.sessions.waitUpdates(id, 0, 1)).items, "error")).message).toBe(
      "plain",
    );
    await k.sessions.dispose();
  });

  it("PromptHook can rewrite the text", async () => {
    const k = rig({ "acp.prompt": (c) => Promise.resolve(`[${(c as { text: string }).text}]`) });
    const id = await open(k);
    k.agent.script = (t) => t.say(t.text).then(() => "end_turn");
    await k.sessions.prompt(id, "hi");
    await tick();
    const items = (await k.sessions.waitUpdates(id, 0, 1)).items;
    expect(only(itemsOf(items, "user")).text).toBe("[hi]");
    expect(only(itemsOf(items, "agent")).text).toBe("[hi]");
    await k.sessions.dispose();
  });
});
