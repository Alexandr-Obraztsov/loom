import { Component, useCallback, useSyncExternalStore } from "react";
import type { ComponentType, ReactNode } from "react";
import type { ResolvedNode, TreeResult } from "@loom/kernel";
import { useKernel } from "./provider.js";

/** Re-renders when plugins change; the snapshot is the kernel's current (immutable) tree. */
export function useTree(): TreeResult {
  const kernel = useKernel();
  // a failed reconcile rebuilds the tree too (rollback) and reports only plugins.failed
  const subscribe = useCallback(
    (notify: () => void) => {
      const offs = [kernel.on("plugins.changed", notify), kernel.on("plugins.failed", notify)];
      return () => {
        for (const off of offs) off();
      };
    },
    [kernel],
  );
  return useSyncExternalStore(subscribe, () => kernel.tree);
}

function Placeholder(props: { id: string; message: string }): ReactNode {
  return (
    <div role="alert">
      Расширение «{props.id}» не загрузилось: {props.message}
    </div>
  );
}

interface BoundaryProps {
  id: string;
  node: ResolvedNode;
  children: ReactNode;
}
interface BoundaryState {
  error: Error | undefined;
  node: ResolvedNode;
}

class Boundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: undefined, node: this.props.node };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  /** A new node object (the tree changed) gets another chance; re-renders of the same node do not. */
  static getDerivedStateFromProps(
    props: BoundaryProps,
    state: BoundaryState,
  ): BoundaryState | null {
    return props.node === state.node ? null : { error: undefined, node: props.node };
  }

  override render(): ReactNode {
    const { error } = this.state;
    return error ? <Placeholder id={this.props.id} message={error.message} /> : this.props.children;
  }
}

type NodeComponent = ComponentType<{ node: ResolvedNode }>;

export function Render(props: { node: ResolvedNode | undefined; fallback?: ReactNode }): ReactNode {
  const { node, fallback } = props;
  if (!node) return fallback ?? null;
  if (node.error) return <Placeholder id={node.id} message={node.error.message} />;
  const value = node.value as { component?: NodeComponent } | undefined;
  const View = value?.component;
  if (!View) return null;
  return (
    <Boundary key={node.id} id={node.id} node={node}>
      <View node={node} />
    </Boundary>
  );
}

export function RenderRoot(): ReactNode {
  return <Render node={useTree().root} />;
}
