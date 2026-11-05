export { loadPluginsFromDirs } from "./loader.js";
export type { LoadedPlugin, LoadFailure, LoadOptions, LoadResult } from "./loader.js";
// exactly the types the loader's signatures reach; values (LoomError, definePlugin, ...) come from "@loom/kernel"
export type { LoomError, LoomErrorCode, LoomErrorOptions } from "../core/errors.js";
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
} from "../core/types.js";
