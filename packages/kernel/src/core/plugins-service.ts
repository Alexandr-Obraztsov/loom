import { createHook, createServiceRef } from "./definitions.js";
import { LoomError } from "./errors.js";
import type { HookRegistry } from "./hooks.js";
import type { ReconcileDiff } from "./reconcile.js";
import type { HookRef, PluginDefinition, ServiceRef } from "./types.js";

/**
 * The kernel's own service. Every call is queued behind running reconciles,
 * so a plugin must not await it from its own `setup` or `onDispose` (that
 * would wait for the reconcile that is running the plugin: a deadlock).
 */
export interface PluginsService {
  /** Runs BeforeInstallHook, then adds (or replaces) and enables the plugin. */
  install(def: PluginDefinition): Promise<ReconcileDiff>;
  /** Removes the plugin from the catalogue; an unknown id is a no-op. */
  uninstall(id: string): Promise<ReconcileDiff>;
  /** Re-activates a disabled plugin; an unknown id rejects with DEPENDENCY_MISSING. */
  enable(id: string): Promise<ReconcileDiff>;
  /** Keeps the definition but removes it from the active set; an unknown id is a no-op. */
  disable(id: string): Promise<ReconcileDiff>;
  /**
   * Replaces the definition and re-runs its setup even if it is the same object, keeping the enabled flag.
   * An id unknown at call time is installed (through BeforeInstallHook); one uninstalled while this call
   * waited in the queue rejects with DEPENDENCY_MISSING.
   */
  reload(def: PluginDefinition): Promise<ReconcileDiff>;
  list(): readonly { id: string; version: string; enabled: boolean }[];
}

export const PluginsRef: ServiceRef<PluginsService> = createServiceRef<PluginsService>("plugins");

export const BeforeInstallHook: HookRef<{ plugin: PluginDefinition }, Promise<{ allow: boolean; reason?: string }>> =
  createHook<{ plugin: PluginDefinition }, Promise<{ allow: boolean; reason?: string }>>("plugins.beforeInstall", {
    mode: "async",
  });

export interface CatalogEntry {
  readonly def: PluginDefinition;
  readonly enabled: boolean;
}

export interface CatalogChange {
  readonly catalog: readonly CatalogEntry[];
  /** Ids whose setup must re-run even if their definition is unchanged. */
  readonly force?: readonly string[];
}

export interface PluginsServiceHost {
  /** Queues `change`, applied to the catalogue current at that time; the catalogue is committed only if the reconcile succeeds. */
  submit(change: (catalog: readonly CatalogEntry[]) => CatalogChange): Promise<ReconcileDiff>;
  catalog(): readonly CatalogEntry[];
  run: HookRegistry["run"];
}

function upsert(catalog: readonly CatalogEntry[], entry: CatalogEntry): CatalogEntry[] {
  const i = catalog.findIndex((e) => e.def.id === entry.def.id);
  if (i < 0) return [...catalog, entry];
  return catalog.map((e, j) => (j === i ? entry : e));
}

function entryOf(catalog: readonly CatalogEntry[], id: string): CatalogEntry {
  const entry = catalog.find((e) => e.def.id === id);
  if (!entry) throw new LoomError("DEPENDENCY_MISSING", `Plugin "${id}" is not installed`, { pluginIds: [id] });
  return entry;
}

function setEnabled(id: string, enabled: boolean) {
  return (catalog: readonly CatalogEntry[]): CatalogChange => ({
    catalog: catalog.map((e) => (e.def.id === id ? { def: e.def, enabled } : e)),
  });
}

export function createPluginsService(host: PluginsServiceHost): PluginsService {
  const install = async (def: PluginDefinition): Promise<ReconcileDiff> => {
    const verdict = await host.run(BeforeInstallHook, { plugin: def }, () => Promise.resolve({ allow: true }));
    if (!verdict.allow) {
      const why = verdict.reason === undefined ? "" : `: ${verdict.reason}`;
      throw new LoomError("INSTALL_DENIED", `Installation of plugin "${def.id}" was denied${why}`, {
        pluginIds: [def.id],
        details: verdict.reason === undefined ? {} : { reason: verdict.reason },
      });
    }
    return host.submit((catalog) => ({ catalog: upsert(catalog, { def, enabled: true }), force: [def.id] }));
  };

  return {
    install,
    uninstall: (id) => host.submit((catalog) => ({ catalog: catalog.filter((e) => e.def.id !== id) })),
    enable: (id) =>
      host.submit((catalog) => {
        entryOf(catalog, id);
        return setEnabled(id, true)(catalog);
      }),
    disable: (id) => host.submit(setEnabled(id, false)),
    reload(def) {
      if (!host.catalog().some((e) => e.def.id === def.id)) return install(def);
      // Re-checked in the queue: an uninstall queued earlier must not let reload skip BeforeInstallHook.
      return host.submit((catalog) => ({
        catalog: upsert(catalog, { def, enabled: entryOf(catalog, def.id).enabled }),
        force: [def.id],
      }));
    },
    list: () => host.catalog().map((e) => ({ id: e.def.id, version: e.def.version, enabled: e.enabled })),
  };
}
