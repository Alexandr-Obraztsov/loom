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
export { createKernel, KERNEL_ID } from "./core/kernel.js";
export type { Kernel, KernelConfig, KernelOptions, KernelServices } from "./core/kernel.js";
export { BeforeInstallHook, PluginsRef } from "./core/plugins-service.js";
export type { PluginsService } from "./core/plugins-service.js";
export type { ReconcileDiff } from "./core/reconcile.js";
export { createRpcEndpoint } from "./rpc/endpoint.js";
export type { RpcEndpoint, RpcHandler } from "./rpc/endpoint.js";
export { createMemoryTransportPair } from "./rpc/memory-transport.js";
export type { MemoryTransport } from "./rpc/memory-transport.js";
export type { AbortControllerLike, AbortSignalLike } from "./rpc/platform.js";
export type { Outcome, RpcMessage, SerializedError, Transport } from "./rpc/protocol.js";
export { exposeHooks } from "./rpc/remote-hooks.js";
export { exposeServices, remoteServicesPlugin } from "./rpc/remote-services.js";
export type { RemoteServicesOptions } from "./rpc/remote-services.js";
export { tapRemote } from "./rpc/remote-taps.js";
