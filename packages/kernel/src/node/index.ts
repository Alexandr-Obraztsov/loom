export { loadPluginsFromDirs } from "./loader.js";
export type { LoadedPlugin, LoadFailure, LoadOptions, LoadResult } from "./loader.js";
// the loader's signatures mention the plugin and error types, so this entry point must be able to name them
export type * from "../core/errors.js";
export type * from "../core/types.js";
