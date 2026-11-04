import { satisfies } from "semver";
import { LoomError } from "./errors.js";
import type { PluginDefinition } from "./types.js";

export interface ResolvedOrder {
  readonly order: readonly PluginDefinition[];
  readonly skippedOptional: ReadonlyMap<string, string[]>;
}

interface Problem {
  plugin: string;
  dependency: string;
  required?: string;
  actual?: string;
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function sortedKeys(record: Record<string, string> | undefined): string[] {
  return record === undefined ? [] : Object.keys(record).sort(byId);
}

function allDeps(plugin: PluginDefinition): string[] {
  return [...new Set([...sortedKeys(plugin.dependsOn), ...sortedKeys(plugin.optionalDependsOn)])].sort(byId);
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/** Binary min-heap of strings (ids). */
class MinHeap {
  private readonly items: string[] = [];

  get size(): number {
    return this.items.length;
  }

  push(value: string): void {
    const items = this.items;
    let i = items.push(value) - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (byId((items[parent] as string), value) <= 0) break;
      items[i] = (items[parent] as string);
      i = parent;
    }
    items[i] = value;
  }

  pop(): string {
    const items = this.items;
    const top = (items[0] as string);
    const last = items.pop() as string;
    if (items.length === 0) return top;
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= items.length) break;
      if (child + 1 < items.length && byId((items[child + 1] as string), (items[child] as string)) < 0) child++;
      if (byId((items[child] as string), last) >= 0) break;
      items[i] = (items[child] as string);
      i = child;
    }
    items[i] = last;
    return top;
  }
}

function indexById(plugins: readonly PluginDefinition[]): Map<string, PluginDefinition> {
  const map = new Map<string, PluginDefinition>();
  const duplicates = new Set<string>();
  for (const plugin of plugins) {
    if (map.has(plugin.id)) duplicates.add(plugin.id);
    map.set(plugin.id, plugin);
  }
  if (duplicates.size > 0) {
    const ids = [...duplicates].sort(byId);
    throw new LoomError("MANIFEST_INVALID", `Duplicate plugin ids: ${ids.join(", ")}`, {
      pluginIds: ids,
      details: { problems: ids.map((id) => ({ plugin: id, dependency: id })) },
    });
  }
  return map;
}

function fail(code: "DEPENDENCY_MISSING" | "DEPENDENCY_VERSION", message: string, problems: Problem[]): never {
  const involved = new Set<string>();
  for (const p of problems) {
    involved.add(p.plugin);
    involved.add(p.dependency);
  }
  throw new LoomError(code, message, { pluginIds: [...involved], details: { problems } });
}

function checkDependencies(
  map: Map<string, PluginDefinition>,
): Map<string, string[]> {
  const missing: Problem[] = [];
  const mismatched: Problem[] = [];
  const skippedOptional = new Map<string, string[]>();
  for (const id of [...map.keys()].sort(byId)) {
    const plugin = map.get(id) as PluginDefinition;
    const groups = [
      { record: plugin.dependsOn, optional: false },
      { record: plugin.optionalDependsOn, optional: true },
    ];
    for (const { record, optional } of groups) {
      for (const dep of sortedKeys(record)) {
        const range = (record as Record<string, string>)[dep] as string;
        const target = map.get(dep);
        if (target === undefined) {
          if (!optional) missing.push({ plugin: id, dependency: dep, required: range });
          else push(skippedOptional, id, dep);
        } else if (!satisfies(target.version, range, { includePrerelease: true })) {
          mismatched.push({ plugin: id, dependency: dep, required: range, actual: target.version });
        }
      }
    }
  }
  if (missing.length > 0) {
    fail("DEPENDENCY_MISSING", describe("Missing required dependencies", missing), missing);
  }
  if (mismatched.length > 0) {
    fail("DEPENDENCY_VERSION", describe("Dependency version mismatch", mismatched), mismatched);
  }
  return skippedOptional;
}

function describe(title: string, problems: Problem[]): string {
  const lines = problems.map(
    (p) => `${p.plugin} -> ${p.dependency} (${JSON.stringify(p.required)}${p.actual === undefined ? "" : `, found ${p.actual}`})`,
  );
  return `${title}: ${lines.join("; ")}`;
}

/** Walks from the smallest remaining node along its smallest remaining dependency until a node repeats. */
function findCycle(remaining: Set<string>, map: Map<string, PluginDefinition>): string[] {
  const start = [...remaining].sort(byId)[0] as string;
  const path: string[] = [];
  const seen = new Map<string, number>();
  let current = start;
  while (!seen.has(current)) {
    seen.set(current, path.length);
    path.push(current);
    current = allDeps(map.get(current) as PluginDefinition).find((d) => remaining.has(d)) as string;
  }
  return path.slice(seen.get(current));
}

export function resolveOrder(plugins: readonly PluginDefinition[]): ResolvedOrder {
  const map = indexById(plugins);
  const skippedOptional = checkDependencies(map);

  const pending = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const [id, plugin] of map) {
    const deps = allDeps(plugin).filter((d) => map.has(d));
    pending.set(id, deps.length);
    for (const dep of deps) push(dependents, dep, id);
  }

  const ready = new MinHeap();
  for (const [id, count] of pending) if (count === 0) ready.push(id);
  const order: PluginDefinition[] = [];
  while (ready.size > 0) {
    const id = ready.pop();
    order.push(map.get(id) as PluginDefinition);
    for (const next of dependents.get(id) ?? []) {
      const left = (pending.get(next) as number) - 1;
      pending.set(next, left);
      if (left === 0) ready.push(next);
    }
  }

  if (order.length < map.size) {
    const done = new Set(order.map((p) => p.id));
    const remaining = new Set([...map.keys()].filter((id) => !done.has(id)));
    const cycle = findCycle(remaining, map);
    throw new LoomError("DEPENDENCY_CYCLE", `Dependency cycle: ${[...cycle, cycle[0]].join(" -> ")}`, {
      pluginIds: cycle,
      details: { cycle },
    });
  }
  return { order, skippedOptional };
}

export function dependentsOf(ids: Iterable<string>, plugins: readonly PluginDefinition[]): Set<string> {
  const reverse = new Map<string, string[]>();
  for (const plugin of plugins) {
    for (const dep of allDeps(plugin)) push(reverse, dep, plugin.id);
  }
  const result = new Set<string>(ids);
  const queue = [...result];
  for (let i = 0; i < queue.length; i++) {
    for (const next of reverse.get(queue[i] as string) ?? []) {
      if (!result.has(next)) {
        result.add(next);
        queue.push(next);
      }
    }
  }
  return result;
}
