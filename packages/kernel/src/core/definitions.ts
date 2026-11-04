import type { ExtensionDefinition, HookRef, PluginDefinition, ServiceRef } from "./types.js";

export function definePlugin(def: PluginDefinition): PluginDefinition {
  return def;
}

export function createServiceRef<T>(id: string): ServiceRef<T> {
  return { id, kind: "service" };
}

export function createHook<C, R>(id: string, opts: { mode?: "sync" | "async" } = {}): HookRef<C, R> {
  return { id, kind: "hook", mode: opts.mode ?? "async" };
}

export function createExtension<O>(def: ExtensionDefinition<O>): ExtensionDefinition<O> {
  return def;
}

function canonical(value: unknown): string {
  if (typeof value === "function") return `[fn:${value.name}]`;
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
  return `{${entries.join(",")}}`;
}

/** FNV-1a 32-bit over a key-sorted serialization; functions contribute only their names. */
function stableHash(value: unknown): string {
  const text = canonical(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    hash = Math.imul(hash ^ (unit & 0xff), 0x01000193) >>> 0;
    hash = Math.imul(hash ^ (unit >> 8), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function attach<O>(
  parentId: string,
  input: string,
  value: O & { id?: string },
  opts: { order?: number } = {},
): ExtensionDefinition<O> {
  const valueId = (value as { id?: string } | null | undefined)?.id;
  const def: ExtensionDefinition<O> = {
    id: `${parentId}/${input}/${valueId ?? stableHash(value)}`,
    attachTo: { id: parentId, input },
    factory: () => value,
  };
  if (opts.order !== undefined) def.order = opts.order;
  return def;
}
