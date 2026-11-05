interface Window {
  /** Exposed by the preload script. */
  readonly loom: { project(): Promise<string> };
}
