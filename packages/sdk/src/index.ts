export type { Host } from "./host.js";
export { HostRef } from "./host.js";
export type {
  AbortSignalLike,
  ExtensionContext,
  ExtensionDefinition,
  HookRef,
  InputSpec,
  LoomErrorCode,
  LoomErrorOptions,
  Next,
  PluginContext,
  PluginDefinition,
  PluginsService,
  ProvideRemoteServicesOptions,
  ReconcileDiff,
  RemoteTapOptions,
  ResolvedNode,
  RpcEndpoint,
  RpcHandler,
  ServiceRef,
  TapOptions,
} from "@loom/kernel";
export { attach, createExtension, createHook, createServiceRef, definePlugin, LoomError, PluginsRef, provideRemoteServices, tapRemote } from "@loom/kernel";
