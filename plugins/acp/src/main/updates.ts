import type { ContentBlock, SessionUpdate, ToolCallContent } from "@agentclientprotocol/sdk";

import type { SessionItem, SessionSnapshot } from "../api.js";

export const BATCH_MS = 16;
const DEFAULT_WAIT_MS = 25000;

type ToolItem = Extract<SessionItem, { kind: "tool" }>;
type TextKind = "user" | "agent" | "thought";
type ToolFields = {
  toolCallId: string;
  title?: string | null | undefined;
  status?: ToolItem["status"] | null | undefined;
  content?: readonly ToolCallContent[] | null | undefined;
};

const textOf = (block: ContentBlock): string => (block.type === "text" ? block.text : "");

function detailOf(content: readonly ToolCallContent[] | null | undefined): string | undefined {
  const text = (content ?? [])
    .map((c) => (c.type === "content" ? textOf(c.content) : ""))
    .filter((t) => t !== "")
    .join("\n");
  return text === "" ? undefined : text;
}

/**
 * Event log of one session. Mutations are queued and applied in one batch (`BATCH_MS`), which
 * then bumps `seq` once and wakes the `wait` callers; so a burst of chunks costs one wake-up.
 */
export class SessionLog {
  seq = 0;
  private items: SessionItem[] = [];
  private isBusy = false;
  private queue: (() => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private waiters = new Set<{ after: number; wake: () => void }>();
  private counter = 0;

  constructor(readonly sessionId: string) {}

  newId(prefix: string): string {
    this.counter += 1;
    return `${prefix}${String(this.counter)}`;
  }

  snapshot(): SessionSnapshot {
    return { sessionId: this.sessionId, seq: this.seq, items: [...this.items], busy: this.isBusy };
  }

  apply(update: SessionUpdate): void {
    this.enqueue(() => {
      this.applyUpdate(update);
    });
  }

  addUser(text: string): void {
    const id = this.newId("u");
    this.enqueue(() => this.items.push({ kind: "user", id, text }));
  }

  setBusy(isBusy: boolean): void {
    this.enqueue(() => {
      this.isBusy = isBusy;
    });
  }

  addError(message: string, stderr?: string): void {
    const id = this.newId("e");
    this.enqueue(() =>
      this.items.push(
        stderr ? { kind: "error", id, message, stderr } : { kind: "error", id, message },
      ),
    );
  }

  addItem(item: SessionItem): void {
    this.enqueue(() => this.items.push(item));
  }

  resolvePermission(id: string, resolved: string): void {
    this.enqueue(() => {
      // ids are unique across kinds
      this.items = this.items.map((i) => (i.id === id ? ({ ...i, resolved } as SessionItem) : i));
    });
  }

  /** Resolves when `seq > after`, or after `timeoutMs` with the current snapshot. */
  wait(after: number, timeoutMs: number = DEFAULT_WAIT_MS): Promise<SessionSnapshot> {
    if (this.seq > after) return Promise.resolve(this.snapshot());
    return new Promise((resolve) => {
      const waiter = {
        after,
        wake: (): void => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          resolve(this.snapshot());
        },
      };
      const timer = setTimeout(waiter.wake, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  /** Stops the batch timer and releases every waiter. */
  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const w of [...this.waiters]) w.wake();
  }

  private enqueue(fn: () => unknown): void {
    this.queue.push(() => void fn());
    this.timer ??= setTimeout(() => {
      this.flush();
    }, BATCH_MS);
  }

  private flush(): void {
    this.timer = undefined;
    const queued = this.queue.splice(0);
    for (const fn of queued) fn();
    this.seq += 1;
    for (const w of [...this.waiters]) if (this.seq > w.after) w.wake();
  }

  /**
   * One entry per update kind: a new kind in `SessionUpdate` fails to compile until it is decided here.
   * `undefined` = not shown in the timeline; a kind the agent sends outside the union falls through too.
   */
  private static readonly HANDLERS: {
    [K in SessionUpdate["sessionUpdate"]]: ((log: SessionLog, update: Extract<SessionUpdate, { sessionUpdate: K }>) => void) | undefined;
  } = {
    user_message_chunk: (log, u) => {
      log.appendText("user", textOf(u.content));
    },
    agent_message_chunk: (log, u) => {
      log.appendText("agent", textOf(u.content));
    },
    agent_thought_chunk: (log, u) => {
      log.appendText("thought", textOf(u.content));
    },
    tool_call: (log, u) => {
      log.upsertTool(u);
    },
    tool_call_update: (log, u) => {
      log.upsertTool(u);
    },
    available_commands_update: undefined,
    compaction_summary_chunk: undefined,
    compaction_update: undefined,
    config_option_update: undefined,
    current_mode_update: undefined,
    notice: undefined,
    plan: undefined,
    session_info_update: undefined,
    usage_update: undefined,
  };

  private applyUpdate(update: SessionUpdate): void {
    const handler = SessionLog.HANDLERS[update.sessionUpdate] as ((log: SessionLog, u: SessionUpdate) => void) | undefined;
    handler?.(this, update);
  }

  private appendText(kind: TextKind, text: string): void {
    const last = this.items.at(-1);
    if (last?.kind === kind) {
      this.items[this.items.length - 1] = { ...last, text: last.text + text };
    } else {
      this.items.push({ kind, id: this.newId(kind[0] as string), text });
    }
  }

  private upsertTool(update: ToolFields): void {
    const at = this.items.findIndex((i) => i.kind === "tool" && i.id === update.toolCallId);
    const prev = this.items[at];
    const base: ToolItem =
      prev?.kind === "tool"
        ? prev
        : { kind: "tool", id: update.toolCallId, title: update.toolCallId, status: "pending" };
    const detail = detailOf(update.content) ?? base.detail;
    const next: ToolItem = {
      ...base,
      title: update.title ?? base.title,
      status: update.status ?? base.status,
      ...(detail === undefined ? {} : { detail }),
    };
    if (at === -1) this.items.push(next);
    else this.items[at] = next;
  }
}
