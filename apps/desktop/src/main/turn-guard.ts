import { PromptHook, SessionsRef } from "@loom/plugin-acp";
import type { PluginDefinition } from "@loom/sdk";
import { definePlugin } from "@loom/sdk";

export interface TurnGuard {
  readonly plugin: PluginDefinition;
  /** Cancels the turn of every session that was prompted; pending permissions resolve as cancelled. */
  cancelRunning(): Promise<void>;
}

/**
 * Remembers which sessions got prompts so main can cancel their turns when the window page goes
 * away (close, reload, crash): the agent must not keep working for a UI that is no longer there.
 */
export function createTurnGuard(): TurnGuard {
  const prompted = new Set<string>();
  let cancel: ((sessionId: string) => Promise<void>) | undefined;
  const plugin = definePlugin({
    id: "desktop",
    version: "0.1.0",
    dependsOn: { acp: "^0.1.0" },
    setup(ctx) {
      const sessions = ctx.use(SessionsRef);
      cancel = (id) => sessions.cancel(id);
      ctx.tap(PromptHook, {}, (c, next) => {
        prompted.add(c.sessionId);
        return next(c);
      });
    },
  });
  return {
    plugin,
    async cancelRunning() {
      const cancelOne = cancel;
      if (!cancelOne) return;
      // an unknown or closed session or a disposed kernel has nothing left to cancel
      await Promise.all([...prompted].map((id) => cancelOne(id).catch(() => undefined)));
    },
  };
}
