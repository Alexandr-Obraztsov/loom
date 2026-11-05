import type { SessionSnapshot, Sessions } from "@loom/plugin-acp";

/**
 * Памятный Sessions для тестов композера: записывает prompt/cancel, отдаёт
 * управляемые отказы и замки; waitUpdates висит до мутации (семантика acp SessionLog).
 */
export class FakeSessions implements Sessions {
  readonly prompts: [sessionId: string, text: string][] = [];
  readonly cancels: string[] = [];
  /** Когда задан — ближайший prompt отклоняется этим значением (сбрасывается после). */
  promptError: unknown;
  /** Когда задан — cancel отклоняется этим значением. */
  cancelError: Error | undefined;
  private snapshot: SessionSnapshot;
  private readonly waiters = new Set<() => void>();
  private ensureGate: Promise<void> | undefined;
  private promptGate: Promise<void> | undefined;

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

  /** Пока замокнут, prompt не отвечает; разблокирует releasePrompt(). */
  lockPrompt(): void {
    this.promptGate = new Promise((resolve) => {
      this.releasePrompt = resolve;
    });
  }

  releasePrompt(): void {
    // заменяется lockPrompt; по умолчанию ничего не ждёт
  }

  async ensure(): Promise<SessionSnapshot> {
    if (this.ensureGate !== undefined) await this.ensureGate;
    return this.snapshot;
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    this.prompts.push([sessionId, text]);
    if (this.promptGate !== undefined) await this.promptGate;
    if (this.promptError === undefined) return;
    const error = this.promptError;
    this.promptError = undefined;
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- тест намеренно отклоняет не-Error'ом (rpc может принести что угодно)
    throw error;
  }

  cancel(sessionId: string): Promise<void> {
    this.cancels.push(sessionId);
    return this.cancelError === undefined ? Promise.resolve() : Promise.reject(this.cancelError);
  }

  async respondPermission(): Promise<void> {
    // разрешения композеру не нужны; метод нужен интерфейсу Sessions
  }

  async close(): Promise<void> {
    // закрытие сеанса композеру не нужно; метод нужен интерфейсу Sessions
  }

  waitUpdates(_sessionId: string, afterSeq: number): Promise<SessionSnapshot> {
    if (this.snapshot.seq > afterSeq) return Promise.resolve(this.snapshot);
    return new Promise((resolve) => {
      const wake = (): void => {
        this.waiters.delete(wake);
        resolve(this.snapshot);
      };
      this.waiters.add(wake);
    });
  }

  /** Тестовая мутация: заменить снимок (seq растёт на 1) и разбудить ожидающий опрос. */
  emit(fn: (s: SessionSnapshot) => SessionSnapshot): void {
    this.snapshot = { ...fn(this.snapshot), seq: this.snapshot.seq + 1 };
    for (const wake of [...this.waiters]) wake();
  }
}
