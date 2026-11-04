import type { Navigation } from "./api.js";

/** The `NavigationRef` implementation: current id plus change subscribers. */
export function createNavigation(): Navigation {
  let currentId: string | undefined;
  const listeners = new Set<() => void>();
  return {
    current: () => currentId,
    go(screenId: string): void {
      if (screenId === currentId) return;
      currentId = screenId;
      for (const fn of listeners) fn();
    },
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
