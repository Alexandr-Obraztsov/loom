declare module "virtual:loom/main-plugins" {
  import type { PluginDefinition } from "@loom/sdk";
  export const plugins: PluginDefinition[];
}

declare module "virtual:loom/renderer-plugins" {
  import type { PluginDefinition } from "@loom/sdk";
  export const plugins: PluginDefinition[];
}
