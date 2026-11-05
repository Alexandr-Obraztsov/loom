import { LoomError } from "./errors.js";
import type { ExtensionDefinition, InputSpec } from "./types.js";

export interface TreeEntry {
  readonly pluginId: string;
  readonly ext: ExtensionDefinition;
  readonly override: boolean;
}

export interface TreeIndexConfig {
  readonly rootId?: string;
  readonly disabled?: readonly string[];
  readonly attach?: Readonly<Record<string, { id: string; input: string }>>;
  readonly winners?: Readonly<Record<string, string>>;
}

/** The effective definition of one tree node after override and conflict resolution. */
export interface Placed {
  readonly id: string;
  readonly pluginId: string;
  readonly ext: ExtensionDefinition;
  readonly attach: { readonly id: string; readonly input: string } | undefined;
  readonly inputs: Readonly<Record<string, InputSpec>> | undefined;
  /** Plugin ids of all claimants when the id is contested without a winner. */
  readonly conflict: readonly string[] | undefined;
}

export interface TreeIndex {
  readonly rootId: string;
  readonly placed: ReadonlyMap<string, Placed>;
  readonly disabled: ReadonlySet<string>;
  /** Children by parent id, then input name; each list sorted by order then id. */
  readonly children: ReadonlyMap<string, ReadonlyMap<string, readonly Placed[]>>;
}

export interface Orphan {
  readonly id: string;
  readonly pluginId: string;
  readonly reason: LoomError;
}

function groupById(entries: readonly TreeEntry[], disabled: ReadonlySet<string>): Map<string, TreeEntry[]> {
  const groups = new Map<string, TreeEntry[]>();
  for (const entry of entries) {
    if (disabled.has(entry.ext.id)) continue;
    const list = groups.get(entry.ext.id);
    if (list) list.push(entry);
    else groups.set(entry.ext.id, [entry]);
  }
  return groups;
}

function place(id: string, group: readonly TreeEntry[], config: TreeIndexConfig): Placed {
  const overrides = group.filter((x) => x.override);
  const originals = group.filter((x) => !x.override);
  const candidates = overrides.length > 0 ? overrides : originals;
  const winnerId = config.winners?.[id];
  const winner = candidates.length > 1 ? candidates.find((c) => c.pluginId === winnerId) : undefined;
  // group is never empty, and neither is whichever of overrides/originals was picked
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- needed under noUncheckedIndexedAccess in tsc
  const chosen = winner ?? (candidates[0] as TreeEntry);
  const contested = candidates.length > 1 && winner === undefined;
  // An override swaps just the factory unless it declares its own placement.
  const original = overrides.length > 0 ? (originals.find((o) => o.pluginId === winnerId) ?? originals[0]) : undefined;
  return {
    id,
    pluginId: chosen.pluginId,
    ext: chosen.ext,
    attach: config.attach?.[id] ?? chosen.ext.attachTo ?? original?.ext.attachTo,
    inputs: chosen.ext.inputs ?? original?.ext.inputs,
    conflict: contested ? [...new Set(candidates.map((c) => c.pluginId))] : undefined,
  };
}

/** Ids are unique within an index, so equality never occurs. */
function byId(a: { readonly id: string }, b: { readonly id: string }): number {
  return a.id < b.id ? -1 : 1;
}

function byOrderThenId(a: Placed, b: Placed): number {
  const d = (a.ext.order ?? 0) - (b.ext.order ?? 0);
  return d !== 0 ? d : byId(a, b);
}

export function indexEntries(entries: readonly TreeEntry[], config: TreeIndexConfig): TreeIndex {
  const rootId = config.rootId ?? "app";
  const disabled = new Set(config.disabled ?? []);
  const placed = new Map<string, Placed>();
  for (const [id, group] of groupById(entries, disabled)) placed.set(id, place(id, group, config));
  const children = new Map<string, Map<string, Placed[]>>();
  for (const p of placed.values()) {
    if (p.id === rootId || !p.attach) continue;
    let byInput = children.get(p.attach.id);
    if (!byInput) children.set(p.attach.id, (byInput = new Map<string, Placed[]>()));
    const list = byInput.get(p.attach.input);
    if (list) list.push(p);
    else byInput.set(p.attach.input, [p]);
  }
  for (const byInput of children.values()) for (const list of byInput.values()) list.sort(byOrderThenId);
  return { rootId, placed, disabled, children };
}

/** The parent a node hangs off, or the reason it cannot hang off anything. */
function stepUp(index: TreeIndex, p: Placed): string | Placed {
  if (!p.attach) return "has no attachTo";
  if (index.disabled.has(p.attach.id)) return `is attached to disabled "${p.attach.id}"`;
  const parent = index.placed.get(p.attach.id);
  if (!parent) return `is attached to missing parent "${p.attach.id}"`;
  if (!parent.inputs || !Object.hasOwn(parent.inputs, p.attach.input)) {
    return `is attached to unknown input "${p.attach.input}" of "${p.attach.id}"`;
  }
  return parent;
}

/** How a detached extension's walk up ends, shared by every node on the way. */
type Terminal =
  | { readonly kind: "missing"; readonly last: Placed; readonly reason: string; readonly pluginIds: readonly string[] }
  | { readonly kind: "cycle"; readonly ring: readonly string[]; readonly pluginIds: readonly string[] };

function addPlugin(plugin: string, ids: readonly string[]): readonly string[] {
  return [...new Set([plugin, ...ids])];
}

/** The attachTo cycle `up` closes: from `up` along `chain` to its end. Built once per cycle and shared. */
function ringOf(chain: readonly Placed[], up: Placed): Terminal {
  const ring = chain.slice(chain.indexOf(up));
  return { kind: "cycle", ring: ring.map((c) => c.id), pluginIds: [...new Set(ring.map((c) => c.pluginId))] };
}

/**
 * Walks up from `start` to the first missing link or to an attachTo cycle. The end of the walk is
 * memoized for every node on the way, so the reasons of a detached chain of n extensions cost O(n)
 * in time and in error size, not O(n²) (a chain hanging off a cycle shares the one ring).
 */
function terminalOf(index: TreeIndex, start: Placed, memo: Map<string, Terminal>): Terminal {
  const chain: Placed[] = [start];
  const seen = new Set([start.id]);
  let cur = start;
  let known = memo.get(cur.id);
  while (!known) {
    const up = stepUp(index, cur);
    if (typeof up !== "string" && !seen.has(up.id)) {
      seen.add(up.id);
      chain.push(up);
      cur = up;
      known = memo.get(cur.id);
    } else {
      known = typeof up === "string" ? { kind: "missing", last: cur, reason: up, pluginIds: [cur.pluginId] } : ringOf(chain, up);
      memo.set(cur.id, known);
    }
  }
  // `chain` ends at the node whose terminal is known (it is memoized); the nodes before it learn it now
  for (let i = chain.length - 2; i >= 0; i--) {
    const node = chain[i] as Placed;
    // a ring member keeps the ring's own plugins; a tail node adds only itself
    known = { ...known, pluginIds: addPlugin(node.pluginId, known.pluginIds) };
    memo.set(node.id, known);
  }
  return known;
}

function reasonFor(index: TreeIndex, start: Placed, memo: Map<string, Terminal>): LoomError {
  const end = terminalOf(index, start, memo);
  if (end.kind === "cycle") {
    return new LoomError("DEPENDENCY_CYCLE", `Extension "${start.id}" is part of or hangs off an attachTo cycle: ${[...end.ring, end.ring[0]].join(" -> ")}`, {
      pluginIds: end.pluginIds,
      details: { chain: end.ring },
    });
  }
  const what = end.last === start ? `Extension "${start.id}" ${end.reason}` : `Extension "${start.id}" is unreachable: ancestor "${end.last.id}" ${end.reason}`;
  return new LoomError("EXTENSION_INPUT_MISMATCH", what, { pluginIds: end.pluginIds });
}

/** Every placed extension that the resolve pass did not reach, with the reason it is detached. */
export function findOrphans(index: TreeIndex, reached: { has(id: string): boolean }): Orphan[] {
  const out: Orphan[] = [];
  const memo = new Map<string, Terminal>();
  for (const p of index.placed.values()) {
    if (!reached.has(p.id)) out.push({ id: p.id, pluginId: p.pluginId, reason: reasonFor(index, p, memo) });
  }
  return out.sort(byId);
}
