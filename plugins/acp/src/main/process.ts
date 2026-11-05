import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import type { ClientApp, ClientConnection, Stream } from "@agentclientprotocol/sdk";
import type { AgentSpec } from "../api.js";

export const STDERR_TAIL_BYTES = 4096;
export const KILL_GRACE_MS = 2000;
/** After `exit`, how long stdio may stay open (a grandchild holding the pipes) before we stop waiting. */
const DRAIN_GRACE_MS = 500;
/** Hard bound on `kill()` after SIGKILL has been sent. */
const KILL_HARD_MS = 3000;

export interface ExitInfo {
  code: number | null;
  signal: string | null;
  /** Spawn failure (e.g. ENOENT). */
  error?: string;
}

export interface AgentProcess {
  stream: Stream;
  /** Resolves once, after stdio is drained. */
  exited: Promise<ExitInfo>;
  stderrTail(): string;
  /** SIGTERM, then SIGKILL after 2 s. Resolves when the process is gone. */
  kill(): Promise<void>;
}

export function spawnAgent(spec: AgentSpec, cwd: string): AgentProcess {
  const child = spawn(spec.command, [...spec.args], {
    cwd,
    env: { ...process.env, ...spec.env },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true, // own process group: kill() takes the whole tree
  });
  let tail = Buffer.alloc(0);
  child.stderr.on("data", (chunk: Buffer) => {
    tail = Buffer.concat([tail, chunk]).subarray(-STDERR_TAIL_BYTES);
  });
  // a dead child makes writes fail with EPIPE; the exit is reported through `exited`
  child.stdin.on("error", () => undefined);

  let done = false;
  const exited = new Promise<ExitInfo>((resolve) => {
    let drain: ReturnType<typeof setTimeout> | undefined;
    const finish = (info: ExitInfo): void => {
      if (done) return;
      done = true;
      clearTimeout(drain);
      resolve(info);
    };
    child.once("error", (e) => {
      finish({ code: null, signal: null, error: e.message });
    });
    // `close` waits for stdio to end, which a surviving grandchild can prevent
    child.once("exit", (code, signal) => {
      drain = setTimeout(() => {
        finish({ code, signal });
      }, DRAIN_GRACE_MS);
    });
    child.once("close", (code, signal) => {
      finish({ code, signal });
    });
  });

  const signalGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // the group is already gone
    }
  };

  return {
    stream: ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ),
    exited,
    stderrTail: () => tail.toString("utf8"),
    async kill() {
      if (done) {
        signalGroup("SIGKILL"); // leftovers of the tree
        return;
      }
      signalGroup("SIGTERM");
      const escalate = setTimeout(() => {
        signalGroup("SIGKILL");
      }, KILL_GRACE_MS);
      let hard: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        exited,
        new Promise((resolve) => {
          hard = setTimeout(resolve, KILL_GRACE_MS + KILL_HARD_MS);
        }),
      ]);
      clearTimeout(escalate);
      clearTimeout(hard);
      signalGroup("SIGKILL"); // a grandchild that outlived the leader
    },
  };
}

/** A running agent as the sessions see it: a connection plus its process lifecycle. */
export interface AgentLink {
  connection: ClientConnection;
  exited: Promise<ExitInfo>;
  stderrTail(): string;
  kill(): Promise<void>;
}

export type Launch = (spec: AgentSpec, cwd: string, app: ClientApp) => AgentLink;

export const launchProcess: Launch = (spec, cwd, app) => {
  const proc = spawnAgent(spec, cwd);
  return {
    connection: app.connect(proc.stream),
    exited: proc.exited,
    stderrTail: () => proc.stderrTail(),
    kill: () => proc.kill(),
  };
};
