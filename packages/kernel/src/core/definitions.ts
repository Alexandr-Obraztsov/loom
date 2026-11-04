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

function scalar(value: unknown): string {
  if (typeof value === "function") return `#fn:${value.name}`;
  if (typeof value === "bigint") return `#${String(value)}n`;
  if (typeof value === "number" && !Number.isFinite(value)) return `#${String(value)}`;
  if (value === undefined || typeof value === "symbol") return `#${String(value)}`;
  return JSON.stringify(value);
}

function sortStrings(items: string[]): string[] {
  return items.sort((a, b) => (a < b ? -1 : 1));
}

function canonical(value: unknown, path: WeakSet<object> = new WeakSet()): string {
  if (typeof value !== "object" || value === null) return scalar(value);
  if (path.has(value)) return "#cycle";
  if (value instanceof Date) return `#date:${String(value.getTime())}`;
  path.add(value);
  const walk = (v: unknown): string => canonical(v, path);
  let out: string;
  if (Array.isArray(value)) out = `[${value.map(walk).join(",")}]`;
  else if (value instanceof Set) out = `#set[${sortStrings([...value].map(walk)).join(",")}]`;
  else if (value instanceof Map) {
    out = `#map[${sortStrings([...value].map(([k, v]) => `${walk(k)}=>${walk(v)}`)).join(",")}]`;
  } else {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${JSON.stringify(k)}:${walk(v)}`);
    out = `{${sortStrings(entries).join(",")}}`;
  }
  path.delete(value);
  return out;
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

/**
 * Wraps `value` as an extension attached to `parentId`/`input`.
 * Without `value.id` the id is a hash of the value's structure; functions contribute
 * only their names, so values differing only in function bodies get the same id.
 * Such collisions are rejected by the duplicate-id check; give anything that holds
 * functions an explicit `id`.
 */
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
