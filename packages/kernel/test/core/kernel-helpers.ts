import { createServiceRef } from "../../src/core/definitions.js";
import { LoomError } from "../../src/core/errors.js";
import type { PluginContext, PluginDefinition, ServiceRef } from "../../src/core/types.js";

export interface Tagged {
  tag(): string;
}

export const refOf = (id: string): ServiceRef<Tagged> => createServiceRef<Tagged>(`svc.${id}`);

export interface Spec extends Partial<Omit<PluginDefinition, "id" | "setup">> {
  deps?: string[];
  optional?: string[];
  provides?: boolean;
  setup?: (ctx: PluginContext) => void | Promise<void>;
}

/**
 * Builds a plugin that logs `setup:id@version` / `dispose:id@version`,
 * counts its setups in `ctx.state.n` and (by default) provides `svc.<id>`.
 */
export function plugin(log: string[], id: string, spec: Spec = {}): PluginDefinition {
  const { deps = [], optional = [], provides: isProviding = true, setup, version = "1.0.0", ...rest } = spec;
  const def: PluginDefinition = {
    id,
    version,
    ...rest,
    async setup(ctx) {
      log.push(`setup:${id}@${version}`);
      ctx.state.n = ((ctx.state.n as number | undefined) ?? 0) + 1;
      ctx.onDispose(() => void log.push(`dispose:${id}@${version}`));
      if (isProviding) ctx.provide(refOf(id), { tag: () => `${id}@${version}` });
      await setup?.(ctx);
    },
  };
  if (deps.length > 0) def.dependsOn = Object.fromEntries(deps.map((d) => [d, "^1.0.0"]));
  if (optional.length > 0) def.optionalDependsOn = Object.fromEntries(optional.map((d) => [d, "^1.0.0"]));
  return def;
}

export async function rejection(promise: Promise<unknown>): Promise<LoomError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof LoomError) return e;
    throw e;
  }
  throw new Error("did not reject");
}

export function thrown(fn: () => unknown): LoomError {
  try {
    fn();
  } catch (e) {
    if (e instanceof LoomError) return e;
    throw e;
  }
  throw new Error("did not throw");
}

export const ids = (defs: readonly { id: string }[]): string[] => defs.map((d) => d.id);

export function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("value was not captured");
  return value;
}
