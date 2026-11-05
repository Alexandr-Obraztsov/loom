import { createServiceRef } from "./definitions.js";
import { LoomError } from "./errors.js";
import type { ReconcileDiff } from "./reconcile.js";
import type { PluginDefinition, ServiceRef } from "./types.js";

/**
 * The kernel's own service. Every call is queued behind running reconciles,
 * so awaiting it from the plugin's own `setup` or `onDispose` would wait for
 * the reconcile that is running that very callback. The service a plugin gets
 * from `ctx.use` detects this: `install`, `uninstall`, `enable`, `disable` and
 * `reload` called while the calling plugin is being set up or torn down reject
 * with a `SETUP_FAILED` whose `details.causeCode` is `"REENTRANT_RECONCILE"`
 * (the pass that runs the callback then fails with the same `causeCode`).
 * Once the callback returned, the plugin may call the service freely.
 *
 * Detected: only a plugin's own handle used during its own setup/teardown.
 * Not detected: another plugin's handle (X passes its handle to Y through a
 * service or a tap and Y's setup awaits it), calls by the host through
 * `Kernel.services` awaited from a setup, and a timer of an old instance firing
 * while the same id reloads. These calls are not refused (background and host
 * calls legitimately queue behind the pass), but awaiting any PluginsService
 * mutation from a setup or teardown deadlocks the pass.
 *
 * Plugins can change one catalogue entry at a time but cannot trigger a full
 * `reconcile()`: replacing the whole plugin set belongs to the host that
 * owns discovery, and a plugin able to do it could unload every other
 * plugin, or itself mid-setup.
 *
 * `enable`, `disable` and `uninstall` of an id that is not in the catalogue reject with
 * `PLUGIN_UNKNOWN` before any reconcile pass runs, so no `plugins.changed` is emitted.
 */
export interface PluginsService {
  /** Adds (or replaces) and enables the plugin. */
  install(def: PluginDefinition): Promise<ReconcileDiff>;
  /** Removes the plugin from the catalogue; an unknown id rejects with PLUGIN_UNKNOWN. */
  uninstall(id: string): Promise<ReconcileDiff>;
  /** Re-activates a disabled plugin; an unknown id rejects with PLUGIN_UNKNOWN. */
  enable(id: string): Promise<ReconcileDiff>;
  /**
   * Keeps the definition but removes it from the active set; an unknown id rejects with PLUGIN_UNKNOWN.
   * Disabling counts as removal: the plugin is torn down and its `ctx.state` is dropped, so `enable`
   * starts it with an empty state.
   */
  disable(id: string): Promise<ReconcileDiff>;
  /**
   * Replaces the definition and re-runs its setup even if it is the same object, keeping the enabled flag.
   * An id unknown at call time is installed; one uninstalled while this call
   * waited in the queue rejects with PLUGIN_UNKNOWN. After `kernel.dispose()` the returned promise
   * rejects with DISPOSED (it never throws synchronously).
   */
  reload(def: PluginDefinition): Promise<ReconcileDiff>;
  list(): readonly { id: string; version: string; enabled: boolean }[];
}

export const PluginsRef: ServiceRef<PluginsService> = createServiceRef<PluginsService>("plugins");

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
}

function upsert(catalog: readonly CatalogEntry[], entry: CatalogEntry): CatalogEntry[] {
  const i = catalog.findIndex((e) => e.def.id === entry.def.id);
  if (i < 0) return [...catalog, entry];
  return catalog.map((e, j) => (j === i ? entry : e));
}

function entryOf(catalog: readonly CatalogEntry[], id: string): CatalogEntry {
  const entry = catalog.find((e) => e.def.id === id);
  if (!entry) throw new LoomError("PLUGIN_UNKNOWN", `Plugin "${id}" is not installed`, { pluginIds: [id] });
  return entry;
}

function setEnabled(id: string, isEnabled: boolean) {
  return (catalog: readonly CatalogEntry[]): CatalogChange => {
    entryOf(catalog, id);
    return { catalog: catalog.map((e) => (e.def.id === id ? { def: e.def, enabled: isEnabled } : e)) };
  };
}

export function createPluginsService(host: PluginsServiceHost): PluginsService {
  const install = (def: PluginDefinition): Promise<ReconcileDiff> =>
    host.submit((catalog) => ({ catalog: upsert(catalog, { def, enabled: true }), force: [def.id] }));

  return {
    install,
    uninstall: (id) =>
      host.submit((catalog) => {
        entryOf(catalog, id);
        return { catalog: catalog.filter((e) => e.def.id !== id) };
      }),
    enable: (id) => host.submit(setEnabled(id, true)),
    disable: (id) => host.submit(setEnabled(id, false)),
    reload(def) {
      let isKnown: boolean;
      try {
        isKnown = host.catalog().some((e) => e.def.id === def.id);
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
      if (!isKnown) return install(def);
      // Re-checked in the queue: an uninstall queued earlier must not turn this reload into a reinstall.
      return host.submit((catalog) => ({
        catalog: upsert(catalog, { def, enabled: entryOf(catalog, def.id).enabled }),
        force: [def.id],
      }));
    },
    list: () => host.catalog().map((e) => ({ id: e.def.id, version: e.def.version, enabled: e.enabled })),
  };
}

/**
 * Each `ctx.use(PluginsRef)` returns a new wrapper. The guard is keyed by plugin id and `isBusy()`,
 * so it covers exactly a plugin's own handle during its own setup or teardown; see `PluginsService`
 * for the paths it does not detect.
 *
 * The view of `service` handed to plugin `pluginId`: the calls that would queue behind a reconcile
 * reject while `isBusy()` (the plugin's setup or teardown is running) instead of waiting for it forever.
 */
export function refuseReentrancy(service: PluginsService, pluginId: string, isBusy: () => boolean): PluginsService {
  const guarded = <A extends unknown[]>(call: (...args: A) => Promise<ReconcileDiff>) =>
    (...args: A): Promise<ReconcileDiff> =>
      isBusy()
        ? Promise.reject(
            new LoomError("SETUP_FAILED", `Plugin "${pluginId}" called PluginsService while its own setup or teardown was running`, {
              pluginIds: [pluginId],
              details: { causeCode: "REENTRANT_RECONCILE" },
            }),
          )
        : call(...args);
  return {
    install: guarded((def) => service.install(def)),
    uninstall: guarded((id) => service.uninstall(id)),
    enable: guarded((id) => service.enable(id)),
    disable: guarded((id) => service.disable(id)),
    reload: guarded((def) => service.reload(def)),
    list: () => service.list(),
  };
}
