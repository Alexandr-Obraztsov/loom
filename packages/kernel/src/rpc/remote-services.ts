import type { Kernel } from "../core/kernel.js";
import type { PluginDefinition, ServiceRef } from "../core/types.js";
import type { RpcEndpoint } from "./endpoint.js";
import { remoteError } from "./protocol.js";

/**
 * Serves each ref over `endpoint` under its ref id. Every call resolves the kernel's current
 * provider (so provider changes are followed) and awaits the method's result. A missing provider
 * fails with SERVICE_MISSING; a member that is not a function fails with RPC_REMOTE_ERROR.
 * Returns a function that stops serving all refs.
 */
export function exposeServices(kernel: Kernel, endpoint: RpcEndpoint, refs: readonly ServiceRef<object>[]): () => void {
  const removers = refs.map((ref) =>
    endpoint.handle(ref.id, async (method, args) => {
      const service = kernel.services.use(ref) as Record<string, unknown>;
      const member = service[method];
      if (typeof member !== "function") {
        throw remoteError(`Service "${ref.id}" has no method "${method}"`);
      }
      return (await Reflect.apply(member, service, args)) as unknown;
    }),
  );
  return () => {
    for (const remove of removers) remove();
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
 * A plugin that provides each ref as an async proxy to services exposed on the other side of
 * `endpoint` (see `exposeServices`): every method returns a Promise that performs
 * `endpoint.call(ref.id, method, args)`. As an ordinary provider it takes part in dependsOn
 * checks, winners and disposal. Replaces the brief's `connectServices`, since a kernel only
 * accepts providers from plugins.
 */
export function remoteServicesPlugin(options: RemoteServicesOptions): PluginDefinition {
  const { id, version = "0.0.0", endpoint, refs } = options;
  return {
    id,
    version,
    setup(ctx) {
      for (const ref of refs) ctx.provide(ref, remoteProxy(endpoint, ref.id));
    },
  };
}
