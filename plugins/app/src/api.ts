import { useCallback, useSyncExternalStore } from "react";
import type { ResolvedNode, ServiceRef } from "@loom/sdk";
import { createServiceRef } from "@loom/sdk";
import { useService, useTree } from "@loom/react";

/**
 * Shell navigation. The service itself knows nothing about the tree:
 * "default current = first screen" is resolved by {@link useCurrentScreen}.
 */
export interface Navigation {
  current(): string | undefined;
  go(screenId: string): void;
  subscribe(fn: () => void): () => void;
}

export const NavigationRef: ServiceRef<Navigation> = createServiceRef<Navigation>("app.navigation");

/**
 * The current screen: a node of the root `app` extension's `screens` input.
 * While nothing is selected, the first screen shows; with no screens at all —
 * undefined. Re-renders on both navigation changes and tree rebuilds.
 */
export function useCurrentScreen(): ResolvedNode | undefined {
  const tree = useTree();
  const navigation = useService(NavigationRef);
  const subscribe = useCallback((notify: () => void) => navigation.subscribe(notify), [navigation]);
  const currentId = useSyncExternalStore(subscribe, () => navigation.current());
  // the `screens` input is `multiple`, so a built node always holds an array here
  const screens = tree.root ? (tree.root.inputs.screens as readonly ResolvedNode[]) : [];
  return screens.find((screen) => screen.id === currentId) ?? screens[0];
}
