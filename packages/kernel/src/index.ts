export * from "./core/disposables.js";
export * from "./core/errors.js";
export { attach, createExtension, createHook, createServiceRef, definePlugin } from "./core/definitions.js";
export { dependentsOf, resolveOrder } from "./core/graph.js";
export type { ResolvedOrder } from "./core/graph.js";
export { createServiceRegistry } from "./core/services.js";
export type { ServiceRegistry } from "./core/services.js";
export { createPluginContext } from "./core/context.js";
export type { PluginContextArgs, ScopedPluginContext } from "./core/context.js";
export { createEventBus } from "./core/events.js";
export type { EventBus } from "./core/events.js";
export { createHookRegistry } from "./core/hooks.js";
export type { HookRegistry } from "./core/hooks.js";
export { buildTree } from "./core/tree.js";
export type { TreeConfig, TreeResult } from "./core/tree.js";
export { validatePlugin } from "./core/manifest.js";
export type {
  ExtensionContext,
  ExtensionDefinition,
  HookRef,
  InputSpec,
  Next,
  PluginContext,
  PluginDefinition,
  ResolvedNode,
  ServiceRef,
  TapOptions,
} from "./core/types.js";

export function createKernel(): never {
  throw new Error("not implemented");
}
