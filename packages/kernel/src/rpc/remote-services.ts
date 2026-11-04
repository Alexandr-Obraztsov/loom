import { kernelInternals } from "../core/kernel.js";
import type { Kernel } from "../core/kernel.js";
import type { PluginContext, PluginDefinition, ServiceRef } from "../core/types.js";
import { channelOf } from "./endpoint.js";
import type { RpcEndpoint } from "./endpoint.js";
import { remoteError } from "./protocol.js";

/**
 * The data member `name` of `service`, found on the instance or up its prototype chain (stopping
 * before Object.prototype / Function.prototype). Only property descriptors are read, so accessors
 * are never invoked; `constructor` and `__proto__` are never exposed.
 */
function memberOf(service: object, name: string): unknown {
  if (name === "constructor" || name === "__proto__") return undefined;
  let object: object | null = service;
  while (object !== null && object !== Object.prototype && object !== Function.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    if (descriptor) return descriptor.value as unknown;
    object = Object.getPrototypeOf(object) as object | null;
  }
  return undefined;
}

/**
 * Serves each ref over `endpoint` under its ref id. Every call resolves the kernel's current
 * provider (so provider changes are followed) and awaits the method's result. A missing provider
 * fails with SERVICE_MISSING; a member that is not a function fails with RPC_REMOTE_ERROR.
 * Protocol errors of the endpoint go to `kernel.error`. Returns a function that stops serving all refs.
 */
export function exposeServices(kernel: Kernel, endpoint: RpcEndpoint, refs: readonly ServiceRef<object>[]): () => void {
  const internals = kernelInternals(kernel);
  const offProtocol = channelOf(endpoint).onProtocolError(kernel, (error) => {
    internals.report(error);
  });
  const removers = refs.map((ref) =>
    endpoint.handle(ref.id, async (method, args) => {
      const service = kernel.services.use(ref);
      const member = memberOf(service, method);
      if (typeof member !== "function") {
        throw remoteError(`Service "${ref.id}" has no method "${method}"`);
      }
      // called through the service proxy's forwarding wrapper, which binds `this` to the real implementation
      const call = (service as Record<string, (...a: unknown[]) => unknown>)[method] as (...a: unknown[]) => unknown;
      return await call(...args);
    }),
  );
  return () => {
    for (const remove of removers) remove();
    offProtocol();
  };
}

/** An object whose every string-keyed member is an async method calling `target` remotely. */
function remoteProxy(endpoint: RpcEndpoint, target: string): object {
  const methods = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  return new Proxy(
    {},
    {
      get(_t, key) {
        // `then` stays undefined so the proxy is not mistaken for a thenable when awaited.
        if (typeof key !== "string" || key === "then") return undefined;
        let method = methods.get(key);
        if (!method) {
          method = (...args: unknown[]) => endpoint.call(target, key, args);
          methods.set(key, method);
        }
        return method;
      },
    },
  );
}

export interface RemoteServicesOptions {
  /** Plugin id: the owner of the proxies, which consumers name in `dependsOn`. */
  readonly id: string;
  readonly version?: string;
  readonly endpoint: RpcEndpoint;
  readonly refs: readonly ServiceRef<object>[];
}

/**
 * Provides each ref, on `ctx`, as an async proxy to services exposed on the other side of
 * `endpoint` (see `exposeServices`): every method returns a Promise that performs
 * `endpoint.call(ref.id, method, args)`. For plugins whose endpoint only becomes available
 * inside setup (e.g. taken from `use(HostRef)` on the renderer side); protocol errors of the
 * endpoint go to `kernel.error` and the subscription is released when the plugin is disposed.
 */
export function provideRemoteServices(
  ctx: PluginContext,
  endpoint: RpcEndpoint,
  refs: readonly ServiceRef<object>[],
): void {
  for (const ref of refs) ctx.provide(ref, remoteProxy(endpoint, ref.id));
  const off = channelOf(endpoint).onProtocolError(ctx, (error) => {
    ctx.emit("kernel.error", error);
  });
  ctx.onDispose(off);
}

/**
 * A plugin that provides each ref as an async proxy to services exposed on the other side of
 * `endpoint` (see `exposeServices`): every method returns a Promise that performs
 * `endpoint.call(ref.id, method, args)`. As an ordinary provider it takes part in dependsOn
 * checks, winners and disposal; protocol errors of the endpoint go to `kernel.error`. Replaces the brief's `connectServices`, since a kernel only
 * accepts providers from plugins.
 */
export function remoteServicesPlugin(options: RemoteServicesOptions): PluginDefinition {
  const { id, version = "0.0.0", endpoint, refs } = options;
  return {
    id,
    version,
    setup(ctx) {
      provideRemoteServices(ctx, endpoint, refs);
    },
  };
}
