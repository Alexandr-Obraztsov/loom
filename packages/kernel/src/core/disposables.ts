type Disposer = () => void | Promise<void>;

export interface DisposableStoreOptions {
  readonly onError?: (error: unknown) => void;
}

/**
 * Collects disposers and runs them in reverse order of add.
 *
 * Error policy for disposers added after dispose (they run immediately):
 * with `onError`, both a sync throw and an async rejection go to `onError`
 * and `add()` never throws; without it, a sync throw propagates from `add()`
 * and a rejection is left unhandled (loud, never swallowed).
 */
export class DisposableStore {
  private readonly disposers = new Set<Disposer>();
  private readonly onError: ((error: unknown) => void) | undefined;
  private isDisposed = false;
  private pending: Promise<void> | undefined;

  constructor(options: DisposableStoreOptions = {}) {
    this.onError = options.onError;
  }

  get disposed(): boolean {
    return this.isDisposed;
  }

  /** Registers a disposer; returns a remover. After dispose, runs it immediately. */
  add(fn: Disposer): () => void {
    if (this.isDisposed) {
      this.runLate(fn);
      return () => undefined;
    }
    // Wrap so the same function added twice gets independent entries.
    const entry: Disposer = () => fn();
    this.disposers.add(entry);
    return () => {
      this.disposers.delete(entry);
    };
  }

  /**
   * Runs disposers in reverse order of add; rethrows failures as one AggregateError.
   * A disposer that awaits this same store's dispose() would deadlock.
   */
  dispose(): Promise<void> {
    this.isDisposed = true;
    this.pending ??= this.run();
    return this.pending;
  }

  private runLate(fn: Disposer): void {
    const onError = this.onError;
    if (!onError) {
      void fn();
      return;
    }
    try {
      Promise.resolve(fn()).catch(onError);
    } catch (error) {
      onError(error);
    }
  }

  private async run(): Promise<void> {
    const errors: unknown[] = [];
    const entries = [...this.disposers].reverse();
    this.disposers.clear();
    for (const entry of entries) {
      try {
        await entry();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Failed to dispose");
  }
}
