import type { ZodType } from "zod";

import { LoomError } from "./errors.js";
import type { Orphan, Placed, TreeEntry, TreeIndex } from "./tree-index.js";
import { findOrphans, indexEntries } from "./tree-index.js";
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
  /** Plugin of the parent the node hangs off; it is named by schema errors. */
  readonly parentPlugin: string | undefined;
  readonly kids: readonly ResolvedNode[];
}

const fingerprints = new WeakMap<ResolvedNode, Fingerprint>();
/** Service ref id -> service version seen by the factory when the node was created. */
const usedServices = new WeakMap<ResolvedNode, ReadonlyMap<string, number>>();
/** Every node of a built tree by id, keyed by its root, so the next build need not walk the old tree. */
const nodesOf = new WeakMap<ResolvedNode, ReadonlyMap<string, ResolvedNode>>();
const NO_ERRORS: readonly LoomError[] = [];
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

function sameFingerprint(f: Fingerprint, frame: Frame, parentPlugin: string | undefined): boolean {
  const { p, schema, kids } = frame;
  return (
    f.pluginId === p.pluginId && f.ext === p.ext && f.inputs === p.inputs && f.schema === schema && f.parentPlugin === parentPlugin &&
    f.attachId === p.attach?.id && f.attachInput === p.attach?.input &&
    sameArray(f.conflict, p.conflict) && sameArray(f.kids, kids)
  );
}

/** One declared input of a node with the children attached to it (`healthy`: those without errors). */
interface InputSlot {
  readonly name: string;
  readonly spec: InputSpec;
  readonly all: readonly ResolvedNode[];
  readonly healthy: readonly ResolvedNode[];
}

function inputError(p: Placed, { name, spec, all, healthy }: InputSlot): LoomError | undefined {
  if (!spec.multiple && all.length > 1) {
    const ids = all.map((n) => n.id).join(", ");
    return new LoomError("EXTENSION_CONFLICT", `Input "${name}" of "${p.id}" accepts one extension but got ${String(all.length)}: ${ids}`, {
      pluginIds: [...new Set([p.pluginId, ...all.map((n) => n.pluginId)])],
      details: { input: name, children: all.map((n) => n.id) },
    });
  }
  if (spec.required && healthy.length === 0) {
    return new LoomError("EXTENSION_INPUT_MISMATCH", `Required input "${name}" of "${p.id}" has no usable extension attached`, {
      pluginIds: [p.pluginId],
      details: { input: name },
    });
  }
  return undefined;
}

/** What a node shows (`inputs`), what its factory gets, and every error found before the factory runs. */
function wire(p: Placed, byInput: ReadonlyMap<string, ResolvedNode[]>): { shown: Shown; given: FactoryInputs; errors: LoomError[] } {
  const shown: Shown = {};
  const given: FactoryInputs = {};
  const errors: LoomError[] = [];
  if (p.conflict) {
    errors.push(new LoomError("EXTENSION_CONFLICT", `Extension "${p.id}" is provided by several plugins: ${p.conflict.join(", ")}`, { pluginIds: p.conflict, details: { id: p.id } }));
  }
  for (const [name, spec] of Object.entries(p.inputs ?? {})) {
    const all = byInput.get(name) ?? [];
    const healthy = all.filter((n) => n.errors.length === 0);
    const bad = inputError(p, { name, spec, all, healthy });
    if (bad) errors.push(bad);
    shown[name] = spec.multiple || all.length > 1 ? all : all[0];
    given[name] = spec.multiple ? healthy : healthy[0];
  }
  return { shown, given, errors };
}

function build(frame: Frame, pass: Pass): ResolvedNode {
  const { p, schema } = frame;
  const { shown, given, errors } = wire(p, groupByInput(frame));
  let value: unknown;
  const used = new Map<string, number>();
  const trackedUse: Pass["use"] = (ref) => {
    used.set(ref.id, pass.serviceVersion?.(ref.id) ?? 0);
    return pass.use(ref);
  };
  if (errors.length === 0) {
    try {
      value = p.ext.factory({ inputs: given, use: trackedUse, config: undefined });
    } catch (cause) {
      errors.push(new LoomError("EXTENSION_FACTORY_FAILED", `Factory of extension "${p.id}" threw`, { pluginIds: [p.pluginId], cause }));
    }
  }
  const parsed = errors.length === 0 && schema ? schema.safeParse(value) : undefined;
  if (parsed && !parsed.success) {
    errors.push(new LoomError("EXTENSION_INPUT_MISMATCH", `Value of extension "${p.id}" does not match the schema of its input`, {
      pluginIds: [p.pluginId, ...(p.attach ? [pass.index.placed.get(p.attach.id)?.pluginId ?? ""] : [])].filter(Boolean),
      details: parsed.error.issues,
    }));
  }
  const base = { id: p.id, pluginId: p.pluginId, inputs: shown };
  const node: ResolvedNode = errors.length > 0 ? { ...base, value: undefined, errors } : { ...base, value, errors: NO_ERRORS };
  usedServices.set(node, used);
  return node;
}

/** A previous node is stale if its factory failed or a service it used has changed since. */
function isStale(prev: ResolvedNode, pass: Pass): boolean {
  if (prev.errors.some((x) => x.code === "EXTENSION_FACTORY_FAILED")) return true;
  for (const [refId, version] of usedServices.get(prev) ?? []) {
    if ((pass.serviceVersion?.(refId) ?? 0) !== version) return true;
  }
  return false;
}

function sameCause(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  return a instanceof Error && b instanceof Error && a.name === b.name && a.message === b.message;
}

/** Both nodes failed in their factory in the same way (a retry that threw the same thing again). */
function sameFailure(a: ResolvedNode, b: ResolvedNode): boolean {
  const [x, y] = [a.errors[0], b.errors[0]];
  return a.errors.length === 1 && b.errors.length === 1 && x?.code === "EXTENSION_FACTORY_FAILED" && y?.code === "EXTENSION_FACTORY_FAILED" && sameCause(x.cause, y.cause);
}

type Specs = readonly (readonly [string, InputSpec])[];
const NO_SPECS: Specs = [];
/** `Object.entries(inputs)` per inputs object, so walking a tree allocates no entry lists for unchanged definitions. */
const specsOf = new WeakMap<object, Specs>();

function specsFor(inputs: Placed["inputs"]): Specs {
  if (!inputs) return NO_SPECS;
  let specs = specsOf.get(inputs);
  if (!specs) specsOf.set(inputs, (specs = Object.entries(inputs)));
  return specs;
}

/** A node whose children are being resolved: input `i`, child `j` of it is next; `kids` collects the finished children in that order. */
interface Frame {
  readonly p: Placed;
  readonly schema: ZodType | undefined;
  readonly specs: Specs;
  readonly attached: ReadonlyMap<string, readonly Placed[]> | undefined;
  i: number;
  j: number;
  kids: ResolvedNode[];
  /** How many of `kids` hang off each input (indexed like `specs`); allocated with the first kid. */
  counts: number[];
}

const NO_KIDS: ResolvedNode[] = [];

function frameOf(p: Placed, schema: ZodType | undefined, pass: Pass): Frame {
  return { p, schema, specs: specsFor(p.inputs), attached: pass.index.children.get(p.id), i: 0, j: 0, kids: NO_KIDS, counts: [] };
}

/** The finished children of `frame` grouped by input (every declared input present, maybe empty). */
function groupByInput(frame: Frame): Map<string, ResolvedNode[]> {
  const byInput = new Map<string, ResolvedNode[]>();
  let from = 0;
  frame.specs.forEach(([name], i) => {
    const to = from + (frame.counts[i] ?? 0);
    byInput.set(name, frame.kids.slice(from, to));
    from = to;
  });
  return byInput;
}

/** All children of `frame` are in `frame.kids`: reuse the previous node if nothing it was built from changed, else build. */
function finish(frame: Frame, parentPlugin: string | undefined, pass: Pass): ResolvedNode {
  const { p, schema, kids } = frame;
  const prev = pass.previous.get(p.id);
  const prevPrint = prev && fingerprints.get(prev);
  const isSame = prev !== undefined && prevPrint !== undefined && sameFingerprint(prevPrint, frame, parentPlugin);
  let node = isSame && !isStale(prev, pass) ? prev : build(frame, pass);
  // a failing factory is retried every build, but failing the same way again is no change
  if (isSame && node !== prev && sameFailure(prev, node)) node = prev;
  if (node !== prev) {
    fingerprints.set(node, {
      pluginId: p.pluginId, ext: p.ext, inputs: p.inputs, schema, kids, parentPlugin,
      attachId: p.attach?.id, attachInput: p.attach?.input, conflict: p.conflict,
    });
  }
  pass.nodes.set(p.id, node);
  return node;
}

/** The next unresolved child of `frame` with the schema of its input, or undefined when all are done. */
function nextChild(frame: Frame): { child: Placed; schema: ZodType | undefined } | undefined {
  while (frame.i < frame.specs.length) {
    const [name, spec] = frame.specs[frame.i] as readonly [string, InputSpec];
    const child = frame.attached?.get(name)?.[frame.j++];
    if (child) return { child, schema: spec.schema };
    frame.i++;
    frame.j = 0;
  }
  return undefined;
}

/** Resolves the tree under `root` children first with an explicit stack, so depth is limited by memory, not by the call stack. */
function resolveTree(root: Placed, pass: Pass): ResolvedNode {
  const stack = [frameOf(root, undefined, pass)];
  let done: ResolvedNode | undefined;
  for (let top = stack.at(-1); top; top = stack.at(-1)) {
    const next = nextChild(top);
    if (next) {
      stack.push(frameOf(next.child, next.schema, pass));
      continue;
    }
    stack.pop();
    done = finish(top, stack.at(-1)?.p.pluginId, pass);
    const parent = stack.at(-1);
    if (parent) {
      if (parent.kids === NO_KIDS) {
        parent.kids = [];
        parent.counts = parent.specs.map(() => 0);
      }
      parent.kids.push(done);
      parent.counts[parent.i] = (parent.counts[parent.i] ?? 0) + 1;
    }
  }
  return done as ResolvedNode;
}

/** Errors in tree order: a node's own errors, then those of its inputs' children. Iterative for the same reason as `resolveTree`. */
function collectErrors(root: ResolvedNode | undefined, into: LoomError[]): void {
  const stack = root ? [root] : [];
  for (let node = stack.pop(); node; node = stack.pop()) {
    into.push(...node.errors);
    stack.push(...childrenOf(node).reverse());
  }
}

function orphanKey(o: Orphan): string {
  return [o.id, o.pluginId, o.reason.code, o.reason.message].join("\u0000");
}

function sameOrphans(a: readonly Orphan[], b: readonly Orphan[]): boolean {
  return a.map(orphanKey).join("\n") === b.map(orphanKey).join("\n");
}

/** What `buildTree` builds with, besides the entries and the config. */
export interface TreeBuildOptions {
  readonly use: ExtensionContext<never>["use"];
  /** The last result: nodes whose inputs did not change are reused from it. */
  readonly previous?: TreeResult | undefined;
  /** Current version of a service; a node that used a service whose version moved is rebuilt. */
  readonly serviceVersion?: ((refId: string) => number) | undefined;
}

export function buildTree(entries: readonly TreeEntry[], config: TreeConfig, options: TreeBuildOptions): TreeResult {
  const { use, previous, serviceVersion } = options;
  const index = indexEntries(entries, config);
  // a hand-made `previous` has no fingerprints, so nothing of it could be reused anyway
  const prevNodes = (previous?.root && nodesOf.get(previous.root)) ?? NO_NODES;
  const pass: Pass = { index, use, previous: prevNodes, nodes: new Map(), serviceVersion };
  const rootPlaced = index.placed.get(index.rootId);
  const root = rootPlaced ? resolveTree(rootPlaced, pass) : undefined;
  if (root) nodesOf.set(root, pass.nodes);
  const orphans = findOrphans(index, pass.nodes);
  if (previous && previous.root === root && sameOrphans(previous.orphans, orphans)) return previous;
  const errors: LoomError[] = [];
  collectErrors(root, errors);
  for (const o of orphans) errors.push(o.reason);
  return { root, orphans, errors };
}
