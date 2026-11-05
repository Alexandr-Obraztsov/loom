import type { SessionItem, Sessions,SessionSnapshot } from "@loom/plugin-acp";

/**
 * Памятная реализация Sessions с семантикой waitUpdates как у acp SessionLog:
 * вызов ждёт, пока seq превысит afterSeq, иначе висит до следующей мутации.
 */
export class FakeSessions implements Sessions {
  readonly ensureCalls: { agentId: string; cwd: string }[] = [];
  readonly responses: [sessionId: string, itemId: string, optionId: string | null][] = [];
  waitCalls = 0;
  /** Сколько ближайших вызовов waitUpdates отклонять (транспорт лёг). */
  failWaitTimes = 0;
  /** Когда задан — waitUpdates зависает и отклоняется только по rejectPendingWait(). */
  shouldFailWaitOnDemand = false;
  /** Сколько ближайших respondPermission отклонять (потеря отклика). */
  failRespondTimes = 0;
  /** Когда задано — ensure отклоняется этим (агент не стартовал). */
  ensureError: unknown;

  private snapshot: SessionSnapshot;
  private readonly waiters = new Set<() => void>();
  private ensureGate: Promise<void> | undefined;
  private waitRejector: ((e: Error) => void) | undefined;

  constructor(readonly sessionId = "s1") {
    this.snapshot = { sessionId, seq: 0, items: [], busy: false };
  }

  /** Пока замокнут, ensure не отвечает; разблокирует releaseEnsure(). */
  lockEnsure(): void {
    this.ensureGate = new Promise((resolve) => {
      this.releaseEnsure = resolve;
    });
  }

  releaseEnsure(): void {
    // заменяется lockEnsure; по умолчанию ничего не ждёт
  }

  async ensure(opts: { agentId: string; cwd: string }): Promise<SessionSnapshot> {
    this.ensureCalls.push({ agentId: opts.agentId, cwd: opts.cwd });
    if (this.ensureGate !== undefined) await this.ensureGate;
    return this.ensureError === undefined
      ? Promise.resolve(this.snapshot)
      : // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- тест намеренно отклоняет не-Error'ом (rpc может принести что угодно)
        Promise.reject(this.ensureError);
  }

  prompt(): Promise<void> {
    return Promise.resolve();
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  /** Отклоняет зависший waitUpdates (см. failWaitOnDemand). */
  rejectPendingWait(): void {
    const reject = this.waitRejector;
    this.waitRejector = undefined;
    if (reject !== undefined) reject(new Error("rpc недоступен"));
  }

  /** Отклонённый respondPermission НЕ разрешает элемент — как настоящий бэкенд. */
  respondPermission(sessionId: string, itemId: string, optionId: string | null): Promise<void> {
    this.responses.push([sessionId, itemId, optionId]);
    if (this.failRespondTimes > 0) {
      this.failRespondTimes -= 1;
      return Promise.reject(new Error("нет связи"));
    }
    this.mutate((s) => ({
      ...s,
      items: s.items.map((i) =>
        i.kind === "permission" && i.id === itemId
          ? { ...i, resolved: optionId ?? "cancelled" }
          : i,
      ),
    }));
    return Promise.resolve();
  }

  waitUpdates(sessionId: string, afterSeq: number): Promise<SessionSnapshot> {
    this.waitCalls += 1;
    if (this.failWaitTimes > 0) {
      this.failWaitTimes -= 1;
      return Promise.reject(new Error("rpc недоступен"));
    }
    if (this.shouldFailWaitOnDemand) {
      return new Promise((_, reject) => {
        this.waitRejector = reject;
      });
    }
    if (this.snapshot.seq > afterSeq) return Promise.resolve(this.snapshot);
    return new Promise((resolve) => {
      const wake = (): void => {
        this.waiters.delete(wake);
        resolve(this.snapshot);
      };
      this.waiters.add(wake);
    });
  }

  /** Тестовая мутация: заменить снимок (seq растёт на 1) и разбудить ожидающих. */
  emit(fn: (s: SessionSnapshot) => SessionSnapshot): void {
    this.mutate((s) => {
      const next = fn(s);
      return { ...next, seq: s.seq + 1 };
    });
  }

  private mutate(fn: (s: SessionSnapshot) => SessionSnapshot): void {
    this.snapshot = fn(this.snapshot);
    for (const wake of [...this.waiters]) wake();
  }
}

export const user = (id: string, text: string): SessionItem => ({ kind: "user", id, text });

export const agent = (id: string, text: string): SessionItem => ({ kind: "agent", id, text });

export const thought = (id: string, text: string): SessionItem => ({
  kind: "thought",
  id,
  text,
});

export type ToolStatus = Extract<SessionItem, { kind: "tool" }>["status"];

export const tool = (id: string, title: string, status: ToolStatus): SessionItem => ({
  kind: "tool",
  id,
  title,
  status,
});
