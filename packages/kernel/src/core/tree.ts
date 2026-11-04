import type { ZodType } from "zod";
import { LoomError } from "./errors.js";
import { findOrphans, indexEntries } from "./tree-index.js";
import type { Orphan, Placed, TreeEntry, TreeIndex } from "./tree-index.js";
import type { ExtensionContext, InputSpec, ResolvedNode } from "./types.js";

export interface TreeConfig {
  rootId?: string;
  disabled?: readonly string[];
  attach?: Readonly<Record<string, { id: string; input: string }>>;
  winners?: Readonly<Record<string, string>>;
}

export interface TreeResult {
  root: ResolvedNode | undefined;
  orphans: readonly { id: string; pluginId: string; reason: LoomError }[];
  errors: readonly LoomError[];
}

type FactoryInputs = Record<string, ResolvedNode | ResolvedNode[] | undefined>;
type Shown = Record<string, ResolvedNode | readonly ResolvedNode[] | undefined>;

/** What a node was built from; two equal fingerprints (and equal children) mean the node can be reused. */
interface Fingerprint {
  readonly pluginId: string;
  readonly ext: Placed["ext"];
  readonly inputs: Placed["inputs"];
  readonly attachId: string | undefined;
  readonly attachInput: string | undefined;
  readonly conflict: Placed["conflict"];
  readonly schema: ZodType | undefined;
  readonly kids: readonly ResolvedNode[];
}

const fingerprints = new WeakMap<ResolvedNode, Fingerprint>();
/** Service ref id -> service version seen by the factory when the node was created. */
const usedServices = new WeakMap<ResolvedNode, ReadonlyMap<string, number>>();
/** Every node of a built tree by id, keyed by its root, so the next build need not walk the old tree. */
const nodesOf = new WeakMap<ResolvedNode, ReadonlyMap<string, ResolvedNode>>();
const NO_NODES: ReadonlyMap<string, ResolvedNode> = new Map();

interface Pass {
  readonly index: TreeIndex;
  readonly use: ExtensionContext<never>["use"];
  readonly previous: ReadonlyMap<string, ResolvedNode>;
  /** Nodes of the tree being built, by id (the reached extensions). */
  readonly nodes: Map<string, ResolvedNode>;
  readonly serviceVersion: ((refId: string) => number) | undefined;
}

function childrenOf(node: ResolvedNode): ResolvedNode[] {
  const out: ResolvedNode[] = [];
  for (const v of Object.values(node.inputs)) {
    if (Array.isArray(v)) out.push(...(v as ResolvedNode[]));
    else if (v) out.push(v as ResolvedNode);
  }
  return out;
}

function sameArray<T>(a: readonly T[] | undefined, b: readonly T[] | undefined): boolean {
  if (a === b) return true;
  return a !== undefined && b !== undefined && a.length === b.length && a.every((x, i) => x === b[i]);
}

function sameFingerprint(f: Fingerprint, p: Placed, schema: ZodType | undefined, kids: readonly ResolvedNode[]): boolean {
  return (
    f.pluginId === p.pluginId && f.ext === p.ext && f.inputs === p.inputs && f.schema === schema &&
    f.attachId === p.attach?.id && f.attachInput === p.attach?.input &&
    sameArray(f.conflict, p.conflict) && sameArray(f.kids, kids)
  );
}

function inputError(p: Placed, name: string, spec: InputSpec, all: readonly ResolvedNode[], healthy: number): LoomError | undefined {
  if (!spec.multiple && all.length > 1) {
    const ids = all.map((n) => n.id).join(", ");
    return new LoomError("EXTENSION_CONFLICT", `Input "${name}" of "${p.id}" accepts one extension but got ${String(all.length)}: ${ids}`, {
      pluginIds: [...new Set([p.pluginId, ...all.map((n) => n.pluginId)])],
      details: { input: name, children: all.map((n) => n.id) },
    });
  }
  if (spec.required && healthy === 0) {
    return new LoomError("EXTENSION_INPUT_MISMATCH", `Required input "${name}" of "${p.id}" has no usable extension attached`, {
      pluginIds: [p.pluginId],
      details: { input: name },
    });
  }
  return undefined;
}

function mkNode(p: Placed, inputs: Shown, value: unknown, error: LoomError | undefined): ResolvedNode {
  const base = { id: p.id, pluginId: p.pluginId, inputs };
  return error ? { ...base, value: undefined, error } : { ...base, value };
}

function build(p: Placed, byInput: ReadonlyMap<string, ResolvedNode[]>, schema: ZodType | undefined, pass: Pass): ResolvedNode {
  const shown: Shown = {};
  const given: FactoryInputs = {};
  let error: LoomError | undefined = p.conflict
    ? new LoomError("EXTENSION_CONFLICT", `Extension "${p.id}" is provided by several plugins: ${p.conflict.join(", ")}`, { pluginIds: p.conflict, details: { id: p.id } })
    : undefined;
  for (const [name, spec] of Object.entries(p.inputs ?? {})) {
    const all = byInput.get(name) ?? [];
    const healthy = all.filter((n) => n.error === undefined);
    error ??= inputError(p, name, spec, all, healthy.length);
    shown[name] = spec.multiple || all.length > 1 ? all : all[0];
    given[name] = spec.multiple ? healthy : healthy[0];
  }
  let value: unknown;
  const used = new Map<string, number>();
  const trackedUse: Pass["use"] = (ref) => {
    used.set(ref.id, pass.serviceVersion?.(ref.id) ?? 0);
    return pass.use(ref);
  };
  if (!error) {
    try {
      value = p.ext.factory({ inputs: given, use: trackedUse, config: undefined });
    } catch (cause) {
      error = new LoomError("EXTENSION_FACTORY_FAILED", `Factory of extension "${p.id}" threw`, { pluginIds: [p.pluginId], cause });
    }
  }
  const parsed = !error && schema ? schema.safeParse(value) : undefined;
  if (parsed && !parsed.success) {
    error = new LoomError("EXTENSION_INPUT_MISMATCH", `Value of extension "${p.id}" does not match the schema of its input`, {
      pluginIds: [p.pluginId, ...(p.attach ? [pass.index.placed.get(p.attach.id)?.pluginId ?? ""] : [])].filter(Boolean),
      details: parsed.error.issues,
    });
  }
  const node = mkNode(p, shown, value, error);
  usedServices.set(node, used);
  return node;
}

/** A previous node is stale if its factory failed or a service it used has changed since. */
function isStale(prev: ResolvedNode, pass: Pass): boolean {
  if (prev.error?.code === "EXTENSION_FACTORY_FAILED") return true;
  for (const [refId, version] of usedServices.get(prev) ?? []) {
    if ((pass.serviceVersion?.(refId) ?? 0) !== version) return true;
  }
  return false;
}

function resolveNode(p: Placed, schema: ZodType | undefined, pass: Pass): ResolvedNode {
  const byInput = new Map<string, ResolvedNode[]>();
  const kids: ResolvedNode[] = [];
  const attached = pass.index.children.get(p.id);
  for (const [name, spec] of Object.entries(p.inputs ?? {})) {
    const list: ResolvedNode[] = [];
    for (const c of attached?.get(name) ?? []) {
      const child = resolveNode(c, spec.schema, pass);
      list.push(child);
      kids.push(child);
    }
    byInput.set(name, list);
  }
  const prev = pass.previous.get(p.id);
  const prevPrint = prev && fingerprints.get(prev);
  let node: ResolvedNode;
  if (prev && prevPrint && sameFingerprint(prevPrint, p, schema, kids) && !isStale(prev, pass)) node = prev;
  else {
    node = build(p, byInput, schema, pass);
    fingerprints.set(node, {
      pluginId: p.pluginId, ext: p.ext, inputs: p.inputs, schema, kids,
      attachId: p.attach?.id, attachInput: p.attach?.input, conflict: p.conflict,
    });
  }
  pass.nodes.set(p.id, node);
  return node;
}

function collectErrors(node: ResolvedNode | undefined, into: LoomError[]): void {
  if (!node) return;
  if (node.error) into.push(node.error);
  for (const c of childrenOf(node)) collectErrors(c, into);
}

function orphanKey(o: Orphan): string {
  return [o.id, o.pluginId, o.reason.code, o.reason.message].join("\u0000");
}

function sameOrphans(a: readonly Orphan[], b: readonly Orphan[]): boolean {
  return a.map(orphanKey).join("\n") === b.map(orphanKey).join("\n");
}

export function buildTree(
  entries: readonly TreeEntry[],
  config: TreeConfig,
  use: ExtensionContext<never>["use"],
  previous?: TreeResult,
  serviceVersion?: (refId: string) => number,
): TreeResult {
  const index = indexEntries(entries, config);
  // a hand-made `previous` has no fingerprints, so nothing of it could be reused anyway
  const prevNodes = (previous?.root && nodesOf.get(previous.root)) ?? NO_NODES;
  const pass: Pass = { index, use, previous: prevNodes, nodes: new Map(), serviceVersion };
  const rootPlaced = index.placed.get(index.rootId);
  const root = rootPlaced ? resolveNode(rootPlaced, undefined, pass) : undefined;
  if (root) nodesOf.set(root, pass.nodes);
  const orphans = findOrphans(index, pass.nodes);
  if (previous && previous.root === root && sameOrphans(previous.orphans, orphans)) return previous;
  const errors: LoomError[] = [];
  collectErrors(root, errors);
  for (const o of orphans) errors.push(o.reason);
  return { root, orphans, errors };
}
