import type { ComponentType, ReactNode } from "react";
import { Render } from "@loom/react";
import { definePlugin } from "@loom/sdk";
import type { PluginDefinition, ResolvedNode } from "@loom/sdk";
import { NavigationRef } from "./api.js";
import { createNavigation } from "./navigation.js";

type ShellComponent = ComponentType<{ node: ResolvedNode }>;
type ProviderComponent = ComponentType<{ node: ResolvedNode; children: ReactNode }>;

function componentOf(node: ResolvedNode): ProviderComponent | undefined {
  // errored nodes carry no value, so one optional chain covers both cases
  return (node.value as { component?: ProviderComponent } | undefined)?.component;
}

/** Providers wrap the content outermost-first in their inputs order. */
function wrapInProviders(providers: readonly ResolvedNode[], content: ReactNode): ReactNode {
  let wrapped = content;
  for (const node of providers.toReversed()) {
    const Provider = componentOf(node);
    if (Provider) wrapped = <Provider node={node}>{wrapped}</Provider>;
  }
  return wrapped;
}

function AppView(props: { node: ResolvedNode }): ReactNode {
  const { node } = props;
  // `providers`/`overlays` are `multiple` inputs, `layout` is a single one
  const providers = node.inputs.providers as readonly ResolvedNode[];
  const overlays = node.inputs.overlays as readonly ResolvedNode[];
  const layout = node.inputs.layout as ResolvedNode | undefined;
  const body: ReactNode = layout ? (
    <Render node={layout} />
  ) : (
    <p role="status">Раскладка не установлена</p>
  );
  return wrapInProviders(
    providers,
    <>
      {body}
      {overlays.map((overlay) => (
        <Render key={overlay.id} node={overlay} />
      ))}
    </>,
  );
}

const plugin: PluginDefinition = definePlugin({
  id: "app",
  version: "0.1.0",
  setup(ctx) {
    ctx.provide(NavigationRef, createNavigation());
  },
  extensions: [
    {
      id: "app",
      inputs: {
        providers: { multiple: true },
        layout: {},
        screens: { multiple: true },
        overlays: { multiple: true },
      },
      factory: (): { component: ShellComponent } => ({ component: AppView }),
    },
  ],
});

export default plugin;
