import { AgentApp, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type {
  AgentContext,
  RequestPermissionResponse,
  SessionUpdate,
  StopReason,
} from "@agentclientprotocol/sdk";
import { expect, vi } from "vitest";
import type { AgentRegistry, AgentSpec, SessionItem } from "../src/api.js";
import type { AgentLink, ExitInfo, Launch } from "../src/main/process.js";
import { createAgentRegistry } from "../src/main/registry.js";
import { BATCH_MS } from "../src/main/updates.js";
import { createSessions } from "../src/main/sessions.js";
import type { SessionsDeps, SessionsManager } from "../src/main/sessions.js";

export interface Turn {
  text: string;
  acpSessionId: string;
  client: AgentContext;
  /** Resolves when the client sent session/cancel. */
  cancelled: Promise<void>;
  say(text: string): Promise<void>;
  update(update: SessionUpdate): Promise<void>;
}

class FakeLink implements AgentLink {
  connection: AgentLink["connection"];
  exited: Promise<ExitInfo>;
  killed = 0;
  stderr = "";
  private finish!: (info: ExitInfo) => void;
  private done = false;

  constructor(connection: AgentLink["connection"]) {
    this.connection = connection;
    this.exited = new Promise((resolve) => {
      this.finish = resolve;
    });
  }

  stderrTail(): string {
    return this.stderr;
  }

  /** The agent process dies by itself. */
  crash(code: number, stderr: string): void {
    this.stderr = stderr;
    this.stop({ code, signal: null });
  }

  kill(): Promise<void> {
    this.killed += 1;
    this.stop({ code: null, signal: "SIGTERM" });
    return this.exited.then(() => undefined);
  }

  private stop(info: ExitInfo): void {
    if (this.done) return;
    this.done = true;
    this.connection.close();
    this.finish(info);
  }
}

/** An in-process ACP agent; `script` plays one prompt turn. */
class FakeAgent {
  script: (turn: Turn) => Promise<string> | string = () => "end_turn";
  /** Makes `initialize` wait. */
  initGate: Promise<void> | undefined;
  /** Makes `initialize` fail. */
  initError: string | undefined;
  /** Makes `session/prompt` fail with a JSON-RPC error. */
  promptError: string | undefined;
  readonly links: FakeLink[] = [];
  readonly specs: AgentSpec[] = [];
  private sessions = 0;
  private cancel: () => void = () => undefined;
  private readonly app: AgentApp;

  constructor() {
    this.app = new AgentApp({ name: "fake-agent" })
      .onRequest("initialize", async () => {
        await this.initGate;
        if (this.initError) throw new Error(this.initError);
        return { protocolVersion: PROTOCOL_VERSION };
      })
      .onRequest("session/new", () => ({ sessionId: `acp-${String(++this.sessions)}` }))
      .onRequest("session/prompt", async ({ params, client }) => {
        if (this.promptError) throw new Error(this.promptError);
        const cancelled = new Promise<void>((resolve) => {
          this.cancel = resolve;
        });
        const first = params.prompt[0];
        const turn: Turn = {
          text: first?.type === "text" ? first.text : "",
          acpSessionId: params.sessionId,
          client,
          cancelled,
          say: (text) =>
            turn.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }),
          update: (update) =>
            client.notify("session/update", { sessionId: params.sessionId, update }),
        };
        return { stopReason: (await this.script(turn)) as StopReason };
      })
      .onNotification("session/cancel", () => {
        this.cancel();
      });
  }

  readonly launch: Launch = (spec, _cwd, clientApp) => {
    this.specs.push(spec);
    const link = new FakeLink(clientApp.connect(this.app));
    this.links.push(link);
    return link;
  };
}

export const SPEC: AgentSpec = { id: "fake", title: "Fake", command: "fake", args: [] };

export interface Rig {
  agent: FakeAgent;
  registry: AgentRegistry;
  sessions: SessionsManager;
}

/** `run` plays the hook pipeline: `taps` maps a hook id to its single handler. */
export function rig(taps: Record<string, (ctx: never) => Promise<unknown>> = {}): Rig {
  const agent = new FakeAgent();
  const registry = createAgentRegistry();
  registry.add(SPEC);
  const run = ((hook: { id: string }, ctx: never, fallback: (c: never) => unknown) =>
    taps[hook.id]?.(ctx) ?? fallback(ctx)) as SessionsDeps["run"];
  return {
    agent,
    registry,
    sessions: createSessions({ agents: registry, run, launch: agent.launch }),
  };
}

export const itemsOf = <K extends SessionItem["kind"]>(
  items: readonly SessionItem[],
  kind: K,
): Extract<SessionItem, { kind: K }>[] =>
  items.filter((i): i is Extract<SessionItem, { kind: K }> => i.kind === kind);

export function only<T>(list: readonly T[]): T {
  expect(list).toHaveLength(1);
  return list[0] as T;
}

export const OPEN: { agentId: string; cwd: string } = { agentId: "fake", cwd: "/work" };
export async function tick(ms: number = BATCH_MS): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

export async function open(rg: Rig): Promise<string> {
  const p = rg.sessions.ensure(OPEN);
  await tick(0);
  return (await p).sessionId;
}

export const ask = (t: Turn): Promise<RequestPermissionResponse> =>
  t.client.request("session/request_permission", {
    sessionId: t.acpSessionId,
    toolCall: { toolCallId: "tc", title: "Run ls" },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "no", name: "No", kind: "reject_once" },
    ],
  });
