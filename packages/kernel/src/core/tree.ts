import type { ZodType } from "zod";
import { LoomError } from "./errors.js";
import { childKey, findOrphans, indexEntries } from "./tree-index.js";
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
  readonly attachKey: string;
  readonly conflictKey: string;
  readonly schema: ZodType | undefined;
  readonly kids: readonly ResolvedNode[];
}

const fingerprints = new WeakMap<ResolvedNode, Fingerprint>();

interface Pass {
  readonly index: TreeIndex;
  readonly use: ExtensionContext<never>["use"];
  readonly previous: ReadonlyMap<string, ResolvedNode>;
  readonly reached: Set<string>;
}

function childrenOf(node: ResolvedNode): ResolvedNode[] {
  const out: ResolvedNode[] = [];
  for (const v of Object.values(node.inputs)) {
    if (Array.isArray(v)) out.push(...(v as ResolvedNode[]));
    else if (v) out.push(v as ResolvedNode);
  }
  return out;
}

function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  return (
    a.pluginId === b.pluginId && a.ext === b.ext && a.inputs === b.inputs && a.attachKey === b.attachKey &&
    a.conflictKey === b.conflictKey && a.schema === b.schema &&
    a.kids.length === b.kids.length && a.kids.every((k, i) => k === b.kids[i])
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
  if (!error) {
    try {
      value = p.ext.factory({ inputs: given, use: pass.use, config: undefined });
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
  return mkNode(p, shown, value, error);
}

function resolveNode(p: Placed, schema: ZodType | undefined, pass: Pass): ResolvedNode {
  pass.reached.add(p.id);
  const byInput = new Map<string, ResolvedNode[]>();
  const kids: ResolvedNode[] = [];
  for (const [name, spec] of Object.entries(p.inputs ?? {})) {
    const list = (pass.index.children.get(childKey(p.id, name)) ?? []).map((c) => resolveNode(c, spec.schema, pass));
    byInput.set(name, list);
    kids.push(...list);
  }
  const print: Fingerprint = {
    pluginId: p.pluginId, ext: p.ext, inputs: p.inputs, schema, kids,
    attachKey: p.attach ? childKey(p.attach.id, p.attach.input) : "",
    conflictKey: p.conflict?.join("\u0000") ?? "",
  };
  const prev = pass.previous.get(p.id);
  const prevPrint = prev && fingerprints.get(prev);
  if (prev && prevPrint && sameFingerprint(prevPrint, print)) return prev;
  const node = build(p, byInput, schema, pass);
  fingerprints.set(node, print);
  return node;
}

function collectNodes(node: ResolvedNode | undefined, into: Map<string, ResolvedNode>): void {
  if (!node) return;
  into.set(node.id, node);
  for (const c of childrenOf(node)) collectNodes(c, into);
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
): TreeResult {
  const index = indexEntries(entries, config);
  const prevNodes = new Map<string, ResolvedNode>();
  collectNodes(previous?.root, prevNodes);
  const pass: Pass = { index, use, previous: prevNodes, reached: new Set() };
  const rootPlaced = index.placed.get(index.rootId);
  const root = rootPlaced ? resolveNode(rootPlaced, undefined, pass) : undefined;
  const orphans = findOrphans(index, pass.reached);
  if (previous && previous.root === root && sameOrphans(previous.orphans, orphans)) return previous;
  const errors: LoomError[] = [];
  collectErrors(root, errors);
  for (const o of orphans) errors.push(o.reason);
  return { root, orphans, errors };
}
