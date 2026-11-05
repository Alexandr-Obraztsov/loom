import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BATCH_MS, SessionLog } from "../src/main/updates.js";

describe("SessionLog update dispatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores kinds that only exist on Object.prototype and still applies the next update", () => {
    const log = new SessionLog("s1");
    for (const kind of ["__proto__", "valueOf", "constructor"]) {
      log.apply({ sessionUpdate: kind } as never);
    }
    log.apply({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } });
    expect(() => vi.advanceTimersByTime(BATCH_MS)).not.toThrow();
    expect(log.snapshot().items).toMatchObject([{ kind: "agent", text: "hi" }]);
    log.dispose();
  });
});
