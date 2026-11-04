import { createPluginContext } from "./context.js";
import { LoomError } from "./errors.js";
import { createEventBus } from "./events.js";
import type { EventBus } from "./events.js";
import { createHookRegistry } from "./hooks.js";
import type { HookRegistry } from "./hooks.js";
import { validatePlugin } from "./manifest.js";
import { applyReconcile, planReconcile, presentOptional, treeEntries } from "./reconcile.js";
import type { ReconcileDiff, ReconcilePlan, ReconcileRuntime } from "./reconcile.js";
import { createServiceRegistry } from "./services.js";
import type { ServiceRegistry } from "./services.js";
import { buildTree } from "./tree.js";
import type { TreeConfig, TreeResult } from "./tree.js";
import type { PluginDefinition, ServiceRef } from "./types.js";

export const KERNEL_ID = "kernel";

export interface KernelConfig extends TreeConfig {
  /** Per-plugin config, passed as `ctx.config`. */
  plugins?: Readonly<Record<string, unknown>>;
}

export interface KernelOptions {
  /** Services provided by the kernel owner before the first reconcile; any plugin may `use` them without `dependsOn`. */
  hostServices?: readonly (readonly [ServiceRef<object>, object])[];
  config?: KernelConfig;
  /** Decides whether a `scope: "project"` plugin may load. Without it, project plugins are untrusted. */
  trust?(plugin: PluginDefinition): boolean | Promise<boolean>;
}

export interface PassRequest {
  readonly desired: readonly PluginDefinition[];
  readonly config: KernelConfig;
  readonly force: ReadonlySet<string>;
  /** Replace the service registry (winners changed): every plugin reloads and the tree is rebuilt from scratch. */
  readonly freshServices: boolean;
}

/** A consumer set that allows everything: the kernel may use any provider. */
class AllowAll extends Set<string> {
  override has(): boolean {
    return true;
  }
}
const ALL: ReadonlySet<string> = new AllowAll();
const EMPTY_TREE: TreeResult = { root: undefined, orphans: [], errors: [] };

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Mutable kernel state plus one reconcile pass; callers serialize access. */
export class KernelRuntime {
  readonly hooks: HookRegistry;
  readonly events: EventBus;
  services: ServiceRegistry;
  config: KernelConfig;
  active: readonly PluginDefinition[] = [];
  tree: TreeResult = EMPTY_TREE;
  private pending: KernelConfig;
  private readonly running = new Map<string, () => Promise<void>>();
  private readonly states = new Map<string, Record<string, unknown>>();
  private delivering = false;
  /** Owner -> position in the resolved order; ties in hooks, events and decorators break by it. */
  private ranks = new Map<string, number>();
  private readonly rankOf = (owner: string): number =>
    owner === KERNEL_ID ? -1 : (this.ranks.get(owner) ?? Number.MAX_SAFE_INTEGER);

  constructor(
    private readonly options: KernelOptions,
    private readonly kernelServices: (registry: ServiceRegistry) => void,
  ) {
    this.config = this.pending = options.config ?? {};
    const onError = (e: unknown): void => {
      this.report(e);
    };
    this.hooks = createHookRegistry({ onError, rankOf: this.rankOf });
    this.events = createEventBus({ onError, rankOf: this.rankOf });
    this.services = this.registry(this.config);
  }

  /** Emits `kernel.error`; errors raised while delivering `kernel.error` itself are dropped (nowhere left to report). */
  report(error: unknown): void {
    if (this.delivering) return;
    const err = error instanceof LoomError ? error : new LoomError("TAP_FAILED", describe(error), { cause: error });
    this.delivering = true;
    try {
      this.events.emit("kernel.error", err);
    } finally {
      this.delivering = false;
    }
  }

  /** A kernel-owned proxy that follows registry replacement. */
  use<T extends object>(ref: ServiceRef<T>): T {
    const inner = (): object => this.services.use(ref, KERNEL_ID, ALL);
    return new Proxy<object>(
      {},
      {
        get: (_t, p): unknown => Reflect.get(inner(), p) as unknown,
        has: (_t, p) => Reflect.has(inner(), p),
        ownKeys: () => Reflect.ownKeys(inner()),
        // the provider's prototype chain stays visible: class-instance methods and `instanceof` work through the proxy
        getPrototypeOf: () => Reflect.getPrototypeOf(inner()),
        getOwnPropertyDescriptor: (_t, p) => Reflect.getOwnPropertyDescriptor(inner(), p),
        set: (_t, p, v) => Reflect.set(inner(), p, v),
        defineProperty: (_t, p, d) => Reflect.defineProperty(inner(), p, d),
        deleteProperty: (_t, p) => Reflect.deleteProperty(inner(), p),
      },
    ) as T;
  }

  /**
   * One reconcile pass; see `applyReconcile` for the rollback contract. Hook ordering is batched
   * for the pass (each touched hook is ordered once, before the outcome event is emitted).
   */
  async pass(req: PassRequest): Promise<ReconcileDiff> {
    const desired = await this.trusted(req.desired.map((d) => validatePlugin(d)));
    const force = req.freshServices ? new Set(desired.map((d) => d.id)) : req.force;
    const plan = planReconcile(this.active, desired, force, req.config);
    const previous = { services: this.services, config: this.config };
    const resume = this.hooks.defer();
    try {
      this.pending = req.config;
      this.rank(plan.order);
      if (req.freshServices) this.services = this.registry(req.config);
      try {
        await applyReconcile(plan, this.runtimeFor(plan, previous));
      } catch (error) {
        const alive = plan.current.filter((p) => this.running.has(p.id));
        if (alive.length !== plan.current.length) {
          this.active = alive;
          this.tree = this.buildTree(this.tree);
        }
        resume();
        this.events.emit("plugins.failed", { error });
        throw error;
      }
      for (const id of plan.diff.removed) this.states.delete(id);
      this.active = plan.order;
      this.config = req.config;
      this.rank(plan.order);
      this.tree = this.buildTree(req.freshServices ? undefined : this.tree);
    } finally {
      resume();
    }
    this.events.emit("plugins.changed", plan.diff);
    return plan.diff;
  }

  /**
   * Disposes every plugin in reverse order and drops the kernel's taps and listeners.
   * PluginsRef stays provided so stale proxies reach it and get DISPOSED, not SERVICE_MISSING.
   */
  async disposeAll(): Promise<void> {
    const resume = this.hooks.defer();
    try {
      for (const def of [...this.active].reverse()) await this.teardown(def.id);
    } finally {
      resume();
    }
    this.active = [];
    this.states.clear();
    this.tree = EMPTY_TREE;
    this.hooks.removeOwner(KERNEL_ID);
    this.events.removeOwner(KERNEL_ID);
  }

  /** Ranks owners by `order` and re-sorts every registry, so a reload never moves registrations. No-op if no rank changed. */
  private rank(order: readonly PluginDefinition[]): void {
    const ranks = new Map(order.map((p, i) => [p.id, i]));
    if (ranks.size === this.ranks.size && order.every((p, i) => this.ranks.get(p.id) === i)) return;
    this.ranks = ranks;
    this.hooks.reorder();
    this.events.reorder();
    this.services.reorder();
  }

  private registry(config: KernelConfig): ServiceRegistry {
    const onError = (e: unknown): void => {
      this.report(e);
    };
    const registry = createServiceRegistry({
      kernelOwner: KERNEL_ID,
      onError,
      rankOf: this.rankOf,
      ...(config.winners ? { winners: config.winners } : {}),
    });
    this.kernelServices(registry);
    return registry;
  }

  private async trusted(defs: readonly PluginDefinition[]): Promise<PluginDefinition[]> {
    const out: PluginDefinition[] = [];
    for (const def of defs) {
      if (def.scope !== "project") {
        out.push(def);
        continue;
      }
      let failure: { cause: unknown } | undefined;
      let ok = false;
      try {
        ok = (await this.options.trust?.(def)) === true;
      } catch (cause) {
        failure = { cause };
      }
      if (ok) out.push(def);
      else this.report(new LoomError("UNTRUSTED", `Project plugin "${def.id}" is not trusted`, { pluginIds: [def.id], ...failure }));
    }
    return out;
  }

  private runtimeFor(plan: ReconcilePlan, previous: { services: ServiceRegistry; config: KernelConfig }): ReconcileRuntime {
    let saved = new Map<string, Record<string, unknown>>();
    return {
      setup: (def, active) => this.setup(def, active),
      teardown: (def) => this.teardown(def.id),
      report: (e) => {
        this.report(e);
      },
      snapshot: () => {
        saved = new Map(plan.teardown.map((p) => [p.id, { ...this.states.get(p.id) }]));
      },
      restore: () => {
        this.services = previous.services;
        this.rank(plan.current);
        this.pending = previous.config;
        const known = new Set(plan.current.map((p) => p.id));
        for (const id of [...this.states.keys()]) if (!known.has(id)) this.states.delete(id);
        for (const [id, copy] of saved) {
          const state = this.states.get(id) as Record<string, unknown>;
          for (const key of Object.keys(state)) Reflect.deleteProperty(state, key);
          Object.assign(state, copy);
        }
      },
    };
  }

  private async setup(def: PluginDefinition, active: ReadonlySet<string>): Promise<void> {
    let state = this.states.get(def.id);
    if (!state) this.states.set(def.id, (state = {}));
    const scoped = createPluginContext({
      plugin: def,
      allowed: new Set([...Object.keys(def.dependsOn ?? {}), ...presentOptional(def, active)]),
      config: this.pending.plugins?.[def.id],
      state,
      services: this.services,
      hooks: this.hooks,
      events: this.events,
    });
    this.running.set(def.id, scoped.dispose);
    try {
      await def.setup?.(scoped.ctx);
    } catch (error) {
      await this.teardown(def.id);
      throw error;
    }
  }

  private async teardown(id: string): Promise<void> {
    const dispose = this.running.get(id);
    if (!dispose) return;
    this.running.delete(id);
    try {
      await dispose();
    } catch (cause) {
      this.report(new LoomError("TAP_FAILED", `Disposing plugin "${id}" failed`, { pluginIds: [id], cause }));
    }
  }

  private buildTree(previous: TreeResult | undefined): TreeResult {
    const entries = treeEntries(this.active);
    const use = <T>(ref: ServiceRef<T>): T => this.use(ref as ServiceRef<T & object>);
    const version = (refId: string): number => this.services.version({ id: refId, kind: "service" });
    return buildTree(entries, this.config, use, previous, version);
  }
}
