export { attach, createExtension, createHook, createServiceRef, definePlugin } from "./core/definitions.js";
export * from "./core/disposables.js";
export * from "./core/errors.js";
export type { Kernel, KernelConfig, KernelOptions, KernelServices } from "./core/kernel.js";
export { createKernel, KERNEL_ID } from "./core/kernel.js";
export type { PluginsService } from "./core/plugins-service.js";
export { PluginsRef } from "./core/plugins-service.js";
export type { ReconcileDiff } from "./core/reconcile.js";
export type { TreeConfig, TreeResult } from "./core/tree.js";
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
export type { RpcEndpoint, RpcEndpointOptions, RpcHandler } from "./rpc/endpoint.js";
export { createRpcEndpoint } from "./rpc/endpoint.js";
export type { MemoryTransport } from "./rpc/memory-transport.js";
export { createMemoryTransportPair } from "./rpc/memory-transport.js";
export type { AbortControllerLike, AbortSignalLike } from "./rpc/platform.js";
export type { Outcome, RpcMessage, SerializedError, Transport } from "./rpc/protocol.js";
export { exposeHooks } from "./rpc/remote-hooks.js";
export type { ProvideRemoteServicesOptions, RemoteServicesOptions } from "./rpc/remote-services.js";
export { exposeServices, provideRemoteServices, remoteServicesPlugin } from "./rpc/remote-services.js";
export type { RemoteTapOptions } from "./rpc/remote-taps.js";
export { tapRemote } from "./rpc/remote-taps.js";
