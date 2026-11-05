import { deepEqual } from "./equal.js";
import { LoomError } from "./errors.js";
import type { HookRegistry } from "./hooks.js";
import { KERNEL_ID, KernelRuntime } from "./kernel-runtime.js";
import type { KernelConfig, KernelOptions, PassRequest } from "./kernel-runtime.js";
import { createPluginsService, PluginsRef } from "./plugins-service.js";
import type { CatalogChange, CatalogEntry } from "./plugins-service.js";
import type { ReconcileDiff } from "./reconcile.js";
import type { TreeResult } from "./tree.js";
import type { HookRef, PluginDefinition, ServiceRef } from "./types.js";

export { KERNEL_ID };
export type { KernelConfig, KernelOptions };

/** Service access as the kernel owner: may use any provider. Proxies stay live across a winners change. */
export interface KernelServices {
  use<T extends object>(ref: ServiceRef<T>): T;
  has(ref: ServiceRef<unknown>): boolean;
  providerOf(ref: ServiceRef<unknown>): string | undefined;
}

export interface Kernel {
  /**
   * Makes `desired` the installed set (plugins disabled through PluginsService stay disabled) and
   * applies the difference live. Calls are serialized. Rejects with MANIFEST_INVALID / DEPENDENCY_*
   * before touching any running plugin, and with SETUP_FAILED after a rollback (see `applyReconcile`).
   */
  reconcile(desired: readonly PluginDefinition[]): Promise<ReconcileDiff>;
  /** Active plugins, in resolved order. */
  readonly plugins: readonly PluginDefinition[];
  readonly tree: TreeResult;
  readonly services: KernelServices;
  /** Runs `hook` through its taps, ending in `fallback`; the same entry point the plugin context uses. */
  run<C, R>(hook: HookRef<C, R>, ctx: C, fallback: (ctx: C) => R): R;
  /** Subscribes as the kernel owner; returns an unsubscribe function. */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- payload type is the caller's contract
  on<P>(type: string, listener: (payload: P) => void): () => void;
  /**
   * Replaces the config, serialized with reconciles. Tree-only keys (rootId, disabled, attach) only
   * rebuild the tree; a changed `plugins[id]` reloads that plugin; changed `winners` reload every
   * plugin against a fresh service registry (the registry fixes winners at creation).
   */
  setConfig(config: KernelConfig): Promise<void>;
  /**
   * Disposes all plugins in reverse order; afterwards every method throws or rejects with DISPOSED.
   * Idempotent: every call returns the same promise, so if the first dispose fails, later calls
   * return that same rejected promise rather than retrying.
   */
  dispose(): Promise<void>;
}

/** Hook-ins for sibling layers (rpc): taps under an arbitrary owner and `kernel.error` reporting. Not exported from the package. */
export interface KernelInternals {
  tap: HookRegistry["tap"];
  report(error: unknown): void;
}

const internals = new WeakMap<Kernel, KernelInternals>();

export function kernelInternals(kernel: Kernel): KernelInternals {
  const found = internals.get(kernel);
  if (!found) throw new TypeError("Not a kernel created by createKernel");
  return found;
}

const disposedError = (): LoomError => new LoomError("DISPOSED", "Kernel is disposed");

/** Plugins whose `plugins[id]` config changed reload; changed winners reload everything on a fresh registry. */
function configRequest(catalog: readonly CatalogEntry[], previous: KernelConfig, config: KernelConfig): PassRequest {
  return {
    desired: catalog.filter((e) => e.enabled).map((e) => e.def),
    config,
    force: new Set(catalog.map((e) => e.def.id).filter((id) => !deepEqual(previous.plugins?.[id], config.plugins?.[id]))),
    freshServices: !deepEqual(previous.winners ?? {}, config.winners ?? {}),
  };
}

export function createKernel(options: KernelOptions = {}): Kernel {
  let catalog: readonly CatalogEntry[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  let closing = false;
  let dead = false;
  let disposal: Promise<void> | undefined;

  const live = (): void => {
    if (dead) throw disposedError();
  };

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    if (closing) return Promise.reject(disposedError());
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  };

  const submit = (change: (current: readonly CatalogEntry[]) => CatalogChange): Promise<ReconcileDiff> =>
    enqueue(async () => {
      const next = change(catalog);
      const diff = await rt.pass({
        desired: next.catalog.filter((e) => e.enabled).map((e) => e.def),
        config: rt.config,
        force: new Set(next.force),
        freshServices: false,
      });
      catalog = next.catalog;
      return diff;
    });

  const pluginsService = createPluginsService({
    submit,
    catalog: () => {
      live();
      return catalog;
    },
  });
  const rt = new KernelRuntime(options, (registry) => {
    registry.provide(PluginsRef, pluginsService, KERNEL_ID);
    for (const [ref, service] of options.hostServices ?? []) registry.provide(ref, service, KERNEL_ID);
  });

  const kernel: Kernel = {
    reconcile: (desired) =>
      submit((current) => {
        const enabled = new Map(current.map((e) => [e.def.id, e.enabled]));
        return { catalog: desired.map((def) => ({ def, enabled: enabled.get(def.id) ?? true })) };
      }),
    get plugins() {
      return rt.active;
    },
    get tree() {
      return rt.tree;
    },
    services: {
      use: (ref) => (live(), rt.use(ref)),
      has: (ref) => (live(), rt.services.has(ref)),
      providerOf: (ref) => (live(), rt.services.providerOf(ref)),
    },
    run: (hook, ctx, fallback) => (live(), rt.hooks.run(hook, ctx, fallback)),
    on: (type, listener) => (live(), rt.events.on(type, KERNEL_ID, listener)),
    setConfig: (config) =>
      enqueue(async () => {
        await rt.pass(configRequest(catalog, rt.config, config));
      }),
    dispose: () => {
      disposal ??= enqueue(async () => {
        await rt.disposeAll();
        catalog = [];
        dead = true;
      });
      closing = true;
      return disposal;
    },
  };
  internals.set(kernel, {
    tap: (hook, owner, opts, fn) => (live(), rt.hooks.tap(hook, owner, opts, fn)),
    report: (error) => {
      rt.report(error);
    },
  });
  return kernel;
}
