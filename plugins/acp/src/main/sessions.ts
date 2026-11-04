import { ClientApp, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import type { HookRef } from "@loom/sdk";
import { AcpError, PromptHook, ToolCallHook } from "../api.js";
import type { AgentRegistry, AgentSpec, SessionSnapshot, Sessions } from "../api.js";
import { PermissionBroker } from "./permissions.js";
import type { AgentLink, ExitInfo, Launch } from "./process.js";
import { SessionLog } from "./updates.js";

export interface SessionsDeps {
  agents: AgentRegistry;
  run<C, R>(hook: HookRef<C, R>, ctx: C, fallback: (ctx: C) => R): R;
  launch: Launch;
}

interface Rec {
  readonly id: string;
  readonly spec: AgentSpec;
  readonly cwd: string;
  readonly log: SessionLog;
  readonly broker: PermissionBroker;
  link?: AgentLink;
  acpId?: string;
  /** Handshake done and the process still alive. */
  ready: boolean;
  running: boolean;
  closed: boolean;
}

const describeExit = (info: ExitInfo): string =>
  info.error ?? (info.signal ? `сигнал ${info.signal}` : `код ${String(info.code)}`);

export const HANDSHAKE_TIMEOUT_MS = 30000;

const detailsOf = (e: unknown): string | undefined => {
  if (!(e instanceof RequestError)) return undefined;
  const data = e.data as { details?: unknown } | null | undefined;
  if (data === undefined || data === null) return undefined;
  return typeof data.details === "string" ? data.details : JSON.stringify(data);
};

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const rejectOnExit = async (link: AgentLink): Promise<never> => {
  await link.exited;
  throw new AcpError("AGENT_EXITED", "Агент завершился во время ответа");
};

export class SessionsManager implements Sessions {
  private readonly recs = new Map<string, Rec>();
  private current: Rec | undefined;
  private starting: Promise<Rec> | undefined;
  /** Agents whose handshake is still running; `dispose` must reach them too. */
  private readonly pendingStarts = new Set<AgentLink>();
  /** Agents whose handshake is still running; `dispose` must reach them too. */
  private readonly starting_ = new Set<AgentLink>();

  constructor(private readonly deps: SessionsDeps) {}

  async ensure(opts: { agentId: string; cwd: string }): Promise<SessionSnapshot> {
    if (this.current) return this.current.log.snapshot();
    this.starting ??= this.create(opts)
      .then((rec) => (this.current = rec))
      .finally(() => {
        this.starting = undefined;
      });
    return (await this.starting).log.snapshot();
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    const rec = this.get(sessionId);
    if (rec.running)
      throw new AcpError("SESSION_BUSY", "Агент ещё отвечает на предыдущее сообщение");
    rec.running = true;
    rec.log.setBusy(true); // Stop is shown even while the agent (re)starts
    try {
      const final = await this.deps.run(PromptHook, { sessionId, text }, (c) =>
        Promise.resolve(c.text),
      );
      await this.runTurn(rec, final);
    } catch (e) {
      // an exit has already put its own error item into the log
      if (!(e instanceof AcpError && e.code === "AGENT_EXITED")) {
        if (e instanceof AcpError) rec.log.addError(e.reason, e.stderr);
        else this.failTurn(rec, e);
      }
      throw e;
    } finally {
      rec.running = false;
      rec.log.setBusy(false);
    }
  }

  /** A non-ACP failure (e.g. the agent's JSON-RPC error): log it with details and the stderr tail. */
  private failTurn(rec: Rec, e: unknown): never {
    const details = detailsOf(e);
    const reason = details ? `${messageOf(e)}: ${details}` : messageOf(e);
    const stderr = rec.link?.stderrTail() || undefined;
    rec.log.addError(reason, stderr);
    throw new Error(stderr ? `${reason}\n${stderr}` : reason, { cause: e });
  }

  async cancel(sessionId: string): Promise<void> {
    const rec = this.get(sessionId);
    rec.broker.cancelAll();
    if (rec.ready && rec.link && rec.acpId) {
      await rec.link.connection.agent.notify("session/cancel", { sessionId: rec.acpId });
    }
  }

  respondPermission(sessionId: string, itemId: string, optionId: string | null): Promise<void> {
    this.get(sessionId).broker.respond(itemId, optionId);
    return Promise.resolve();
  }

  async waitUpdates(
    sessionId: string,
    afterSeq: number,
    timeoutMs?: number,
  ): Promise<SessionSnapshot> {
    return await this.get(sessionId).log.wait(afterSeq, timeoutMs);
  }

  async close(sessionId: string): Promise<void> {
    await this.closeRec(this.get(sessionId));
  }

  /** Kills every agent process; further `ensure` calls are not expected. */
  async dispose(): Promise<void> {
    await Promise.all([...this.pendingStarts].map((link) => link.kill()));
    await this.starting?.catch(() => undefined); // a start that just finished is in `recs` afterwards
    await Promise.all([...this.recs.values()].map((rec) => this.closeRec(rec)));
  }

  private get(id: string): Rec {
    const rec = this.recs.get(id);
    if (!rec) throw new AcpError("SESSION_UNKNOWN", `Сессия ${id} не найдена`);
    return rec;
  }

  private async create(opts: { agentId: string; cwd: string }): Promise<Rec> {
    const spec = this.deps.agents.list().find((s) => s.id === opts.agentId);
    if (!spec) throw new AcpError("AGENT_UNKNOWN", `Агент «${opts.agentId}» не зарегистрирован`);
    const id = crypto.randomUUID();
    const log = new SessionLog(id);
    const broker = new PermissionBroker(log, (ctx) =>
      this.deps.run(ToolCallHook, ctx, () => Promise.resolve(undefined)),
    );
    const rec: Rec = {
      id,
      spec,
      cwd: opts.cwd,
      log,
      broker,
      ready: false,
      running: false,
      closed: false,
    };
    await this.start(rec);
    this.recs.set(id, rec);
    return rec;
  }

  /** Spawns the agent and opens an ACP session; also restarts a dead agent. */
  private async start(rec: Rec): Promise<void> {
    rec.ready = false;
    const link = this.deps.launch(rec.spec, rec.cwd, this.buildApp(rec));
    rec.link = link;
    void link.exited.then((info) => {
      this.onExit(rec, link, info);
    });
    this.pendingStarts.add(link);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      rec.acpId = await Promise.race([
        this.handshake(link, rec.cwd),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`агент не ответил за ${String(HANDSHAKE_TIMEOUT_MS / 1000)} с`));
          }, HANDSHAKE_TIMEOUT_MS);
        }),
        link.exited.then((): never => {
          throw new Error("процесс завершился во время запуска");
        }),
      ]);
      rec.ready = true;
    } catch (e) {
      await link.kill();
      const info = await link.exited;
      const killed = info.signal === "SIGTERM" || info.signal === "SIGKILL";
      throw new AcpError(
        "AGENT_START_FAILED",
        `Не удалось запустить агента «${rec.spec.title}»: ${killed ? messageOf(e) : describeExit(info)}`,
        link.stderrTail() || undefined,
      );
    } finally {
      clearTimeout(timer);
      this.pendingStarts.delete(link);
    }
  }

  private buildApp(rec: Rec): ClientApp {
    return new ClientApp({ name: "loom" })
      .onNotification("session/update", ({ params }) => {
        rec.log.apply(params.update);
      })
      .onRequest("session/request_permission", ({ params }) => rec.broker.request(params));
  }

  private async handshake(link: AgentLink, cwd: string): Promise<string> {
    const agent = link.connection.agent;
    await agent.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "loom", version: "0.1.0" },
    });
    return (await agent.request("session/new", { cwd, mcpServers: [] })).sessionId;
  }

  private onExit(rec: Rec, link: AgentLink, info: ExitInfo): void {
    if (rec.link !== link || !rec.ready || rec.closed) return;
    rec.ready = false;
    rec.broker.cancelAll();
    rec.log.addError(
      `Агент «${rec.spec.title}» завершился: ${describeExit(info)}`,
      link.stderrTail() || undefined,
    );
    rec.log.setBusy(false);
  }

  private async runTurn(rec: Rec, text: string): Promise<void> {
    if (!rec.ready) await this.start(rec);
    const link = rec.link as AgentLink;
    rec.log.addUser(text);
    const request = link.connection.agent
      .request("session/prompt", {
        sessionId: rec.acpId as string,
        prompt: [{ type: "text", text }],
      })
      .catch(async (e: unknown) => {
        // a dying process closes the connection before `exited` settles: report it as the exit
        if (!link.connection.signal.aborted) throw e;
        return await rejectOnExit(link);
      });
    await Promise.race([request, rejectOnExit(link)]);
  }

  private async closeRec(rec: Rec): Promise<void> {
    rec.closed = true;
    rec.broker.cancelAll();
    rec.log.dispose();
    this.recs.delete(rec.id);
    this.current = undefined; // one session per window
    await rec.link?.kill();
  }
}

export function createSessions(deps: SessionsDeps): SessionsManager {
  return new SessionsManager(deps);
}
