type Disposer = () => void | Promise<void>;

export class DisposableStore {
  private readonly disposers = new Set<Disposer>();
  private isDisposed = false;
  private pending: Promise<void> | undefined;

  get disposed(): boolean {
    return this.isDisposed;
  }

  /** Registers a disposer; returns a remover. After dispose, runs it immediately. */
  add(fn: Disposer): () => void {
    if (this.isDisposed) {
      void fn();
      return () => undefined;
    }
    // Wrap so the same function added twice gets independent entries.
    const entry: Disposer = () => fn();
    this.disposers.add(entry);
    return () => {
      this.disposers.delete(entry);
    };
  }

  /** Runs disposers in reverse order of add; rethrows failures as one AggregateError. */
  dispose(): Promise<void> {
    this.isDisposed = true;
    this.pending ??= this.run();
    return this.pending;
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
