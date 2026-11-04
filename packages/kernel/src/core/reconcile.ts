import { deepEqual } from "./equal.js";
import { LoomError } from "./errors.js";
import { dependentsOf, resolveOrder } from "./graph.js";
import { indexEntries } from "./tree-index.js";
import type { TreeEntry, TreeIndexConfig } from "./tree-index.js";
import type { PluginDefinition } from "./types.js";

export interface ReconcileDiff {
  added: string[];
  removed: string[];
  reloaded: string[];
  requiresRestart: string[];
}

export interface ReconcilePlan {
  /** Currently active plugins, in their resolved order (the rollback snapshot is taken from here). */
  readonly current: readonly PluginDefinition[];
  /** The desired active plugins, in resolved order. */
  readonly order: readonly PluginDefinition[];
  /** Current plugins to dispose; disposed in reverse of this order. */
  readonly teardown: readonly PluginDefinition[];
  /** Desired plugins to set up, in this order. */
  readonly setup: readonly PluginDefinition[];
  readonly diff: ReconcileDiff;
}

/** Ids of `def`'s optional dependencies that are present in `active`. */
export function presentOptional(def: PluginDefinition, active: ReadonlySet<string>): string[] {
  return Object.keys(def.optionalDependsOn ?? {}).filter((id) => active.has(id)).sort();
}

/** Tree entries contributed by `defs`, in their order. */
export function treeEntries(defs: readonly PluginDefinition[]): TreeEntry[] {
  return defs.flatMap((p) => [
    ...(p.extensions ?? []).map((ext) => ({ pluginId: p.id, ext, override: false })),
    ...(p.overrides ?? []).map((ext) => ({ pluginId: p.id, ext, override: true })),
  ]);
}

/**
 * Rejects extension ids claimed by several plugins (two overrides, or two originals) that
 * `tree.winners` does not settle. Disabled ids are ignored, as the tree ignores them.
 */
function checkExtensionConflicts(defs: readonly PluginDefinition[], tree: TreeIndexConfig): void {
  const conflicts = [...indexEntries(treeEntries(defs), tree).placed.values()]
    .filter((p) => p.conflict !== undefined)
    .map((p) => ({ id: p.id, pluginIds: p.conflict as readonly string[] }));
  if (conflicts.length === 0) return;
  const list = conflicts.map((c) => `"${c.id}" (${c.pluginIds.join(", ")})`).join("; ");
  throw new LoomError("EXTENSION_CONFLICT", `Extension ids claimed by several plugins without a winner: ${list}`, {
    pluginIds: [...new Set(conflicts.flatMap((c) => c.pluginIds))],
    details: { conflicts },
  });
}

/**
 * Pure planning step: resolves the desired order (throws MANIFEST_INVALID /
 * DEPENDENCY_* before anything runs) and computes what must be torn down and
 * set up. A plugin is changed when its definition object or version differs,
 * when its set of present optional dependencies differs, or when it is in
 * `force`. Changed and removed plugins and everything depending on them
 * (transitively, in the old or new graph) are affected; added ones affect nobody.
 * Extension id conflicts without a winner in `tree` reject with EXTENSION_CONFLICT here.
 */
export function planReconcile(
  current: readonly PluginDefinition[],
  desired: readonly PluginDefinition[],
  force: ReadonlySet<string> = new Set(),
  tree: TreeIndexConfig = {},
): ReconcilePlan {
  const { order } = resolveOrder(desired);
  checkExtensionConflicts(order, tree);
  const before = new Map(current.map((p) => [p.id, p]));
  const beforeIds = new Set(before.keys());
  const afterIds = new Set(order.map((p) => p.id));
  const removed = current.filter((p) => !afterIds.has(p.id)).map((p) => p.id);
  const changed = order
    .filter((p) => {
      const old = before.get(p.id);
      if (!old) return false;
      if (old !== p || old.version !== p.version || force.has(p.id)) return true;
      return presentOptional(old, beforeIds).join() !== presentOptional(p, afterIds).join();
    })
    .map((p) => p.id);
  const affected = dependentsOf([...changed, ...removed], current);
  for (const id of dependentsOf(changed, order)) affected.add(id);
  const reloaded = order.filter((p) => beforeIds.has(p.id) && affected.has(p.id));
  return {
    current,
    order,
    teardown: current.filter((p) => affected.has(p.id)),
    setup: order.filter((p) => affected.has(p.id) || !beforeIds.has(p.id)),
    diff: {
      added: order.filter((p) => !beforeIds.has(p.id)).map((p) => p.id),
      removed,
      reloaded: reloaded.map((p) => p.id),
      requiresRestart: reloaded
        .filter((p) => !deepEqual(before.get(p.id)?.startup, p.startup))
        .map((p) => p.id),
    },
  };
}

export interface ReconcileRuntime {
  /** Sets up one plugin against `active` (the ids considered present). Must leave nothing registered when it rejects. */
  setup(def: PluginDefinition, active: ReadonlySet<string>): Promise<void>;
  /** Disposes one running plugin. Never rejects: failures are reported by the runtime. */
  teardown(def: PluginDefinition): Promise<void>;
  /** Called once the old versions are torn down, before anything new is set up. */
  snapshot(): void;
  /** Called after a failed pass is undone, before the snapshot is set up again. */
  restore(): void;
  report(error: LoomError): void;
}

/**
 * Applies a plan: tears down affected plugins in reverse order, then sets up
 * affected and added ones in order. If a setup throws, everything set up in
 * this pass is disposed in reverse, `restore()` runs, and the torn-down
 * versions are set up again in order; the result is a SETUP_FAILED naming
 * the failing plugin, with the thrown value as `cause`. When the cause is a
 * LoomError, `pluginIds` is the union of the failing plugin and the cause's
 * plugins (e.g. both sides of a service conflict) and `details.causeCode` is
 * the cause's code.
 *
 * If re-setting up a previous version fails too, the kernel is broken: that
 * plugin and its dependents in the snapshot are left down, each failure is
 * reported, and the SETUP_FAILED carries
 * `details: { rollbackFailed: true, notRestored: [...] }`.
 */
export async function applyReconcile(plan: ReconcilePlan, rt: ReconcileRuntime): Promise<void> {
  for (const def of [...plan.teardown].reverse()) await rt.teardown(def);
  rt.snapshot();
  const next = new Set(plan.order.map((p) => p.id));
  const done: PluginDefinition[] = [];
  for (const def of plan.setup) {
    try {
      await rt.setup(def, next);
    } catch (cause) {
      for (const d of done.reverse()) await rt.teardown(d);
      rt.restore();
      const notRestored = await restoreSnapshot(plan, rt);
      const causeCode = cause instanceof LoomError ? cause.code : undefined;
      const details = {
        ...(causeCode ? { causeCode } : {}),
        ...(notRestored.length > 0 ? { rollbackFailed: true, notRestored } : {}),
      };
      throw new LoomError("SETUP_FAILED", `Setup of plugin "${def.id}" failed${notRestored.length > 0 ? "; rollback failed" : ""}`, {
        pluginIds: cause instanceof LoomError ? [...new Set([def.id, ...cause.pluginIds])] : [def.id],
        cause,
        ...(Object.keys(details).length > 0 ? { details } : {}),
      });
    }
    done.push(def);
  }
}

async function restoreSnapshot(plan: ReconcilePlan, rt: ReconcileRuntime): Promise<string[]> {
  const previous = new Set(plan.current.map((p) => p.id));
  const skip = new Set<string>();
  for (const def of plan.teardown) {
    if (skip.has(def.id)) continue;
    try {
      await rt.setup(def, previous);
    } catch (cause) {
      rt.report(
        new LoomError("SETUP_FAILED", `Rollback could not restore plugin "${def.id}"`, { pluginIds: [def.id], cause }),
      );
      for (const id of dependentsOf([def.id], plan.current)) skip.add(id);
    }
  }
  return plan.teardown.filter((p) => skip.has(p.id)).map((p) => p.id);
}
