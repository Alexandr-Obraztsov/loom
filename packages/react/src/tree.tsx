import { Component, useSyncExternalStore } from "react";
import type { ComponentType, ReactNode } from "react";
import type { ResolvedNode, TreeResult } from "@loom/kernel";
import { useKernel } from "./provider.js";

/** Re-renders when plugins change; the snapshot is the kernel's current (immutable) tree. */
export function useTree(): TreeResult {
  const kernel = useKernel();
  return useSyncExternalStore(
    (notify) => kernel.on("plugins.changed", notify),
    () => kernel.tree,
  );
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
  children: ReactNode;
}
interface BoundaryState {
  error: Error | undefined;
}

class Boundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: undefined };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidUpdate(prev: BoundaryProps): void {
    if (prev.children !== this.props.children && this.state.error)
      this.setState({ error: undefined });
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
    <Boundary key={node.id} id={node.id}>
      <View node={node} />
    </Boundary>
  );
}

export function RenderRoot(): ReactNode {
  return <Render node={useTree().root} />;
}
