import { LoomError } from "./errors.js";

export interface Impl {
  readonly owner: string;
  readonly impl: object;
  readonly seq: number;
}
export interface Decorator {
  readonly owner: string;
  readonly fn: (prev: object) => object;
  readonly seq: number;
}
export interface Resolved {
  readonly version: number;
  readonly owner: string | undefined;
  /** Active registration's impl before decorators; undefined when there is no provider. */
  readonly base: object | undefined;
  /** Both start undefined (never absent), so every Resolved has one shape and the proxy hot path stays monomorphic. */
  decorated: object | undefined;
  failure: LoomError | undefined;
}
export interface RefState {
  readonly id: string;
  version: number;
  readonly provides: Impl[];
  readonly overrides: Impl[];
  readonly decorators: Decorator[];
  resolved: Resolved | undefined;
}
type RankOf = ((owner: string) => number) | undefined;

/** Sorts in place by (owner rank, registration seq); returns whether the order changed. */
export function rankSort(list: { readonly owner: string; readonly seq: number }[], rankOf: RankOf): boolean {
  if (!rankOf) return false;
  const before = list.slice();
  list.sort((a, b) => rankOf(a.owner) - rankOf(b.owner) || a.seq - b.seq);
  return list.some((e, i) => e !== before[i]);
}

/** Re-sorts every registration list; returns ids of refs whose order changed. */
export function reorderAll(states: Iterable<RefState>, rankOf: RankOf): string[] {
  const changed: string[] = [];
  for (const s of states) {
    const moved = [s.provides, s.overrides, s.decorators].map((l) => rankSort(l, rankOf));
    if (moved.includes(true)) changed.push(s.id);
  }
  return changed;
}

export function removeFrom<E>(list: E[], entry: E): boolean {
  const i = list.indexOf(entry);
  if (i < 0) return false;
  list.splice(i, 1);
  return true;
}

/** Removes every registration of `owner` from `states`; returns ids of refs that changed. */
export function stripOwner(states: Iterable<RefState>, owner: string): string[] {
  const changed: string[] = [];
  for (const s of states) {
    const lists = [s.provides, s.overrides, s.decorators] as { owner: string }[][];
    const before = lists.reduce((n, l) => n + l.length, 0);
    for (const list of lists) {
      for (let i = list.length - 1; i >= 0; i--) if (list[i]?.owner === owner) list.splice(i, 1);
    }
    if (lists.reduce((n, l) => n + l.length, 0) !== before) changed.push(s.id);
  }
  return changed;
}

/** Adds `value` to the set kept under `key`. */
export function index<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(value);
}

/** Hands each error to `sink`; returns the errors the sink itself threw. */
export function deliver(errors: readonly unknown[], sink: (e: unknown) => void): unknown[] {
  const failed: unknown[] = [];
  for (const e of errors) {
    try {
      sink(e);
    } catch (sinkError) {
      failed.push(sinkError);
    }
  }
  return failed;
}

export function conflictError(refId: string, existing: string, incoming: string, what: string): LoomError {
  return new LoomError(
    "SERVICE_CONFLICT",
    `service "${refId}" already has a ${what} from "${existing}"; "${incoming}" cannot ${what} it too`,
    { pluginIds: [existing, incoming], details: { ref: refId } },
  );
}

/** Calls every onChange listener for every id; returns their failures wrapped as TAP_FAILED. */
export function callListeners(ids: readonly string[], listeners: ReadonlySet<(refId: string) => void>): LoomError[] {
  const errors: LoomError[] = [];
  for (const id of ids) {
    for (const l of [...listeners]) {
      try {
        l(id);
      } catch (cause) {
        errors.push(new LoomError("TAP_FAILED", `service onChange listener failed for "${id}"`, { cause }));
      }
    }
  }
  return errors;
}
