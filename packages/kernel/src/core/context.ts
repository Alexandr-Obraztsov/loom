import { DisposableStore } from "./disposables.js";
import { LoomError } from "./errors.js";
import type { EventBus } from "./events.js";
import type { HookRegistry } from "./hooks.js";
import type { ServiceRegistry } from "./services.js";
import type { HookRef, Next, PluginContext, PluginDefinition, ServiceRef, TapOptions } from "./types.js";

export interface PluginContextArgs {
  readonly plugin: PluginDefinition;
  /** dependsOn ids plus present optionalDependsOn ids; computed by the caller. */
  readonly allowed: ReadonlySet<string>;
  readonly config: unknown;
  readonly state: Record<string, unknown>;
  readonly services: ServiceRegistry;
  readonly hooks: HookRegistry;
  readonly events: EventBus;
  /** Receives failures of onDispose callbacks registered after dispose. */
  readonly onError?: (err: LoomError) => void;
}

export interface ScopedPluginContext {
  readonly ctx: PluginContext;
  readonly dispose: () => Promise<void>;
}

/**
 * Builds the context passed to `plugin.setup`. Every registration is owned by
 * the plugin id; `dispose` runs onDispose callbacks (reverse order) and then
 * removes the owner from services, hooks and events, even if a callback threw.
 */
export function createPluginContext(args: PluginContextArgs): ScopedPluginContext {
  const { plugin, allowed, services, hooks, events } = args;
  const id = plugin.id;
  const store = new DisposableStore({
    onError: (cause) => {
      args.onError?.(new LoomError("SETUP_FAILED", `onDispose of "${id}" failed after dispose`, { pluginIds: [id], cause }));
    },
  });
  let pending: Promise<void> | undefined;

  const live = (): void => {
    if (pending) throw new LoomError("DISPOSED", `Plugin context of "${id}" is disposed`, { pluginIds: [id] });
  };

  const ctx: PluginContext = {
    id,
    config: args.config,
    state: args.state,
    provide<T extends object>(ref: ServiceRef<T>, impl: T): void {
      live();
      services.provide(ref, impl, id);
    },
    override<T extends object>(ref: ServiceRef<T>, impl: T): void {
      live();
      services.override(ref, impl, id);
    },
    decorate<T extends object>(ref: ServiceRef<T>, fn: (prev: T) => T): void {
      live();
      services.decorate(ref, fn, id);
    },
    use<T extends object>(ref: ServiceRef<T>): T {
      live();
      return services.use(ref, id, allowed);
    },
    tap<C, R>(hook: HookRef<C, R>, opts: TapOptions<C>, fn: (ctx: C, next: Next<C, R>) => R): void {
      live();
      hooks.tap(hook, id, opts, fn);
    },
    run<C, R>(hook: HookRef<C, R>, hookCtx: C, fallback: (ctx: C) => R): R {
      live();
      return hooks.run(hook, hookCtx, fallback);
    },
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- payload type is the caller's contract
    on<P>(type: string, listener: (p: P) => void): void {
      live();
      events.on(type, id, listener);
    },
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- payload type is the caller's contract
    emit<P>(type: string, payload: P): void {
      live();
      events.emit(type, payload);
    },
    onDispose(fn: () => void | Promise<void>): void {
      live();
      store.add(fn);
    },
  };

  const dispose = (): Promise<void> => {
    pending ??= (async () => {
      try {
        await store.dispose();
      } finally {
        services.removeOwner(id);
        hooks.removeOwner(id);
        events.removeOwner(id);
      }
    })();
    return pending;
  };

  return { ctx, dispose };
}
