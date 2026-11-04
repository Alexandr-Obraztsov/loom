import { createHook, createServiceRef } from "@loom/sdk";
import type { HookRef, ServiceRef } from "@loom/sdk";

export interface AgentSpec {
  id: string;
  title: string;
  command: string;
  args: readonly string[];
  env?: Readonly<Record<string, string>>;
}

export interface AgentRegistry {
  /** Adding an existing id replaces it. The returned remover removes only its own entry. */
  add(spec: AgentSpec): () => void;
  list(): readonly AgentSpec[];
}

export const AgentRegistryRef: ServiceRef<AgentRegistry> =
  createServiceRef<AgentRegistry>("acp.agents");

export interface PermissionOptionView {
  optionId: string;
  name: string;
  kind: string;
}

export type SessionItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "agent"; id: string; text: string }
  | { kind: "thought"; id: string; text: string }
  | {
      kind: "tool";
      id: string;
      title: string;
      status: "pending" | "in_progress" | "completed" | "failed";
      detail?: string;
    }
  | {
      kind: "permission";
      id: string;
      title: string;
      options: readonly PermissionOptionView[];
      resolved?: string;
    }
  | { kind: "error"; id: string; message: string; stderr?: string };

export interface SessionSnapshot {
  sessionId: string;
  seq: number;
  items: readonly SessionItem[];
  busy: boolean;
}

export interface Sessions {
  /** One session per window for now; idempotent. */
  ensure(opts: { agentId: string; cwd: string }): Promise<SessionSnapshot>;
  /** Rejects with AcpError "SESSION_BUSY" while a turn is running. */
  prompt(sessionId: string, text: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  /** `null` rejects / cancels the request. */
  respondPermission(sessionId: string, itemId: string, optionId: string | null): Promise<void>;
  /** Resolves when `seq > afterSeq`, or after `timeoutMs` (default 25000) with the current snapshot. */
  waitUpdates(sessionId: string, afterSeq: number, timeoutMs?: number): Promise<SessionSnapshot>;
  close(sessionId: string): Promise<void>;
}

export const SessionsRef: ServiceRef<Sessions> = createServiceRef<Sessions>("acp.sessions");

export interface ToolCallHookContext {
  sessionId: string;
  toolCall: unknown;
  options: readonly { optionId: string; kind: string }[];
}

/** Result: `{ optionId }` selects, `null` cancels, `undefined` asks the user. */
export const ToolCallHook: HookRef<
  ToolCallHookContext,
  Promise<{ optionId: string } | null | undefined>
> = createHook<ToolCallHookContext, Promise<{ optionId: string } | null | undefined>>(
  "acp.toolCall",
);

export const PromptHook: HookRef<{ sessionId: string; text: string }, Promise<string>> = createHook<
  { sessionId: string; text: string },
  Promise<string>
>("acp.prompt");

export type AcpErrorCode =
  "AGENT_START_FAILED" | "AGENT_EXITED" | "SESSION_BUSY" | "SESSION_UNKNOWN" | "AGENT_UNKNOWN";

export class AcpError extends Error {
  readonly code: AcpErrorCode;
  /** The message without the stderr tail. */
  readonly reason: string;
  readonly stderr: string | undefined;
  /** `message` is `reason` followed by the stderr tail (the only part that survives rpc). */
  constructor(code: AcpErrorCode, reason: string, stderr?: string) {
    super(stderr ? `${reason}\n${stderr}` : reason);
    this.name = "AcpError";
    this.code = code;
    this.reason = reason;
    this.stderr = stderr;
  }
}
