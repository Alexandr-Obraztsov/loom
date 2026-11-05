import { useCurrentScreen } from "@loom/plugin-app";
import { Render } from "@loom/react";
import type { PluginDefinition } from "@loom/sdk";
import { definePlugin } from "@loom/sdk";
import type { CSSProperties, ReactNode } from "react";

const FULL_WINDOW: CSSProperties = { position: "fixed", inset: 0 };

/** Bare layout: every role is accepted as an input, only the current screen shows. */
function BareLayout(): ReactNode {
  const screen = useCurrentScreen();
  // Render draws nothing when there is no current screen (no screens attached)
  return (
    <main style={FULL_WINDOW}>
      <Render node={screen} />
    </main>
  );
}

const plugin: PluginDefinition = definePlugin({
  id: "layout-bare",
  version: "0.1.0",
  dependsOn: { app: "^0.1.0" },
  extensions: [
    {
      id: "layout-bare",
      attachTo: { id: "app", input: "layout" },
      inputs: {
        titlebar: {},
        navigation: { multiple: true },
        primary: {},
        auxiliary: { multiple: true },
        status: { multiple: true },
      },
      factory: () => ({ component: BareLayout }),
    },
  ],
});

export default plugin;
