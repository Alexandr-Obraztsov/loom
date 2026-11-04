export * from "./core/disposables.js";
export * from "./core/errors.js";
export { attach, createExtension, createHook, createServiceRef, definePlugin } from "./core/definitions.js";
export { dependentsOf, resolveOrder } from "./core/graph.js";
export type { ResolvedOrder } from "./core/graph.js";
export { createServiceRegistry } from "./core/services.js";
export type { ServiceRegistry } from "./core/services.js";
export { createHookRegistry } from "./core/hooks.js";
export type { HookRegistry } from "./core/hooks.js";
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
