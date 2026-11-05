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
type Fn = (...args: unknown[]) => unknown;
type Members = Record<PropertyKey, unknown>;
export type Winners = Readonly<Record<string, string>>;

/** The registration that currently supplies the ref's base implementation: overrides first, the configured winner, else the first. */
export function pickActive(s: RefState, winners: Winners): Impl | undefined {
  const candidates = s.overrides.length > 0 ? s.overrides : s.provides;
  const winner = winners[s.id];
  return (winner === undefined ? undefined : candidates.find((c) => c.owner === winner)) ?? candidates[0];
}

const NO_DECORATORS: readonly Decorator[] = [];

/**
 * Runs `mutate` and returns the ids of the refs (among `refs`) whose active implementation differs afterwards:
 * the base registration and the decorators, in order, are what an implementation is made of. A registration
 * that does not become active, or a removal of one that was not, changes nothing observable.
 */
export function changedRefs(refs: Iterable<RefState>, winners: Winners, mutate: () => void): string[] {
  const states = [...refs];
  const bases = states.map((s) => pickActive(s, winners));
  const decorators = states.map((s) => (s.decorators.length === 0 ? NO_DECORATORS : s.decorators.slice()));
  mutate();
  const changed: string[] = [];
  states.forEach((s, i) => {
    const before = decorators[i] as readonly Decorator[];
    if (pickActive(s, winners) !== bases[i] || s.decorators.length !== before.length || s.decorators.some((d, k) => d !== before[k])) changed.push(s.id);
  });
  return changed;
}

/** True when `allowed` still has exactly the members of `snapshot` (no sorting or string building: this runs on every `use`). */
export function sameMembers(snapshot: readonly string[], allowed: ReadonlySet<string>): boolean {
  return snapshot.length === allowed.size && snapshot.every((id) => allowed.has(id));
}

const notCallable = (id: string, prop: PropertyKey): TypeError =>
  new TypeError(`"${String(prop)}" of service "${id}" is no longer a function`);

/**
 * A function-valued member of a service as seen through its proxy: it re-resolves on every call, so a held
 * reference keeps forwarding to the active implementation. A plain method (no `prototype`, no statics) gets a
 * bare forwarding arrow; a class or other function with a prototype or statics is mirrored (name, length,
 * `new`, `prototype` and the statics).
 */
export function forwarder(raw: Fn, prop: PropertyKey, id: string, current: () => object): Fn {
  if (!Object.hasOwn(raw, "prototype") && !hasStatics(raw)) {
    // a plain method: a bare forwarding arrow; mirroring name/length would cost two defineProperty calls per proxy member
    return (...args: unknown[]): unknown => {
      const cur = current();
      return Reflect.apply(memberOf(cur, prop, id), cur, args);
    };
  }
  const wrapper: Fn = new Proxy(raw, {
    apply(_t, _this, args: unknown[]) {
      const cur = current();
      return Reflect.apply(memberOf(cur, prop, id), cur, args);
    },
    construct(_t, args: unknown[], newTarget) {
      const fn = memberOf(current(), prop, id);
      return Reflect.construct(fn, args, newTarget === wrapper ? fn : newTarget) as object;
    },
  });
  return wrapper;
}

function memberOf(cur: object, prop: PropertyKey, id: string): Fn {
  const fn = (cur as Members)[prop];
  if (typeof fn !== "function") throw notCallable(id, prop);
  return fn as Fn;
}

/** True when the function has own enumerable properties (statics), without allocating the key list. */
function hasStatics(fn: Fn): boolean {
  for (const _key in fn) return true;
  return false;
}

/** Sorts in place by (owner rank, registration seq). */
export function rankSort(list: { readonly owner: string; readonly seq: number }[], rankOf: RankOf): void {
  if (rankOf) list.sort((a, b) => rankOf(a.owner) - rankOf(b.owner) || a.seq - b.seq);
}

/** Re-sorts every registration list. */
export function reorderAll(states: Iterable<RefState>, rankOf: RankOf): void {
  for (const s of states) for (const l of [s.provides, s.overrides, s.decorators]) rankSort(l, rankOf);
}

export function removeFrom<E>(list: E[], entry: E): boolean {
  const i = list.indexOf(entry);
  if (i < 0) return false;
  list.splice(i, 1);
  return true;
}

/** Removes every registration of `owner` from `states`. */
export function stripOwner(states: Iterable<RefState>, owner: string): void {
  for (const s of states) {
    for (const list of [s.provides, s.overrides, s.decorators] as { owner: string }[][]) {
      for (let i = list.length - 1; i >= 0; i--) if (list[i]?.owner === owner) list.splice(i, 1);
    }
  }
}

/** Whether `s` holds any registration made by `owner`. */
export function holds(s: RefState, owner: string): boolean {
  return [s.provides, s.overrides, s.decorators].some((l) => l.some((e) => e.owner === owner));
}

/** Whether nothing is registered on `s`. */
export function isEmpty(s: RefState): boolean {
  return s.provides.length + s.overrides.length + s.decorators.length === 0;
}

/** Adds `value` to the set kept under `key`. */
export function index<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(value);
}

/** Hands each error to `sink`; returns the errors the sink itself threw. */
function deliver(errors: readonly unknown[], sink: (e: unknown) => void): unknown[] {
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
function callListeners(ids: readonly string[], listeners: ReadonlySet<(refId: string) => void>): LoomError[] {
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

/** Tells every onChange listener about every id; failures go to `onError`, else (or if it throws) they are thrown at the end. */
export function dispatch(
  ids: readonly string[],
  listeners: ReadonlySet<(refId: string) => void>,
  onError: ((error: unknown) => void) | undefined,
): void {
  const errors = callListeners(ids, listeners);
  const failures = onError ? deliver(errors, onError) : errors;
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, `${String(failures.length)} service onChange listeners failed`);
}
