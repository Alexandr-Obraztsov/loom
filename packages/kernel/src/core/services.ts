import { LoomError } from "./errors.js";
import type { ServiceRef } from "./types.js";

export interface ServiceRegistry {
  provide<T extends object>(ref: ServiceRef<T>, impl: T, owner: string): () => void;
  override<T extends object>(ref: ServiceRef<T>, impl: T, owner: string): () => void;
  decorate<T extends object>(ref: ServiceRef<T>, fn: (prev: T) => T, owner: string): () => void;
  /** Returns a live proxy: always forwards to the currently active implementation. */
  use<T extends object>(ref: ServiceRef<T>, consumer: string, allowed: ReadonlySet<string>): T;
  has(ref: ServiceRef<unknown>): boolean;
  providerOf(ref: ServiceRef<unknown>): string | undefined;
  removeOwner(owner: string): void;
  onChange(listener: (refId: string) => void): () => void;
}

export interface ServiceRegistryOptions {
  readonly winners?: Readonly<Record<string, string>>;
  readonly kernelOwner: string;
  /** Receives listener errors (wrapped as TAP_FAILED). Without it they are thrown after all listeners ran. */
  readonly onError?: (error: unknown) => void;
}

interface Impl {
  readonly owner: string;
  readonly impl: object;
}
interface Decorator {
  readonly owner: string;
  readonly fn: (prev: object) => object;
}
interface Resolved {
  readonly version: number;
  readonly owner: string | undefined;
  readonly impl: object | undefined;
  readonly bound: Map<PropertyKey, { raw: unknown; bound: unknown }>;
}
interface RefState {
  readonly id: string;
  version: number;
  readonly provides: Impl[];
  readonly overrides: Impl[];
  readonly decorators: Decorator[];
  resolved: Resolved | undefined;
}

type Winners = Readonly<Record<string, string>>;

function stateOf(states: Map<string, RefState>, id: string): RefState {
  let s = states.get(id);
  if (!s) {
    s = { id, version: 0, provides: [], overrides: [], decorators: [], resolved: undefined };
    states.set(id, s);
  }
  return s;
}

function resolve(s: RefState, winners: Winners): Resolved {
  if (s.resolved?.version === s.version) return s.resolved;
  const candidates = s.overrides.length > 0 ? s.overrides : s.provides;
  const winner = winners[s.id];
  const entry =
    (winner === undefined ? undefined : candidates.find((c) => c.owner === winner)) ??
    candidates[0];
  let impl: object | undefined = entry?.impl;
  if (impl !== undefined) for (const d of s.decorators) impl = d.fn(impl);
  const resolved: Resolved = { version: s.version, owner: entry?.owner, impl, bound: new Map() };
  s.resolved = resolved;
  return resolved;
}

function checkAccess(
  s: RefState,
  owner: string,
  access: { consumer: string; allowed: ReadonlySet<string>; kernelOwner: string },
): void {
  const { consumer, allowed, kernelOwner } = access;
  if (owner === consumer || owner === kernelOwner || allowed.has(owner)) return;
  throw new LoomError(
    "UNDECLARED_DEPENDENCY",
    `"${consumer}" uses service "${s.id}" provided by "${owner}" without declaring a dependency on it`,
    { pluginIds: [consumer], details: { ref: s.id, provider: owner } },
  );
}

function buildProxy(
  s: RefState,
  consumer: string,
  resolveNow: () => Resolved,
  check: (owner: string) => void,
): object {
  let checkedVersion = -1;
  const target = (): Resolved & { impl: object } => {
    const r = resolveNow();
    if (r.impl === undefined || r.owner === undefined) {
      throw new LoomError(
        "SERVICE_MISSING",
        `service "${s.id}" has no active provider (used by "${consumer}")`,
        {
          pluginIds: [consumer],
          details: { ref: s.id },
        },
      );
    }
    if (checkedVersion !== r.version) {
      check(r.owner);
      checkedVersion = r.version;
    }
    return r as Resolved & { impl: object };
  };
  const readOnly = (what: string) => (): never => {
    throw new TypeError(`cannot ${what} on service "${s.id}" through its proxy`);
  };
  return new Proxy<object>(
    {},
    {
      get(_t, prop) {
        const r = target();
        const raw: unknown = Reflect.get(r.impl, prop, r.impl);
        if (typeof raw !== "function") return raw;
        const hit = r.bound.get(prop);
        if (hit?.raw === raw) return hit.bound;
        const bound: unknown = (raw as (...a: unknown[]) => unknown).bind(r.impl);
        r.bound.set(prop, { raw, bound });
        return bound;
      },
      has: (_t, prop) => Reflect.has(target().impl, prop),
      ownKeys: () => Reflect.ownKeys(target().impl),
      getOwnPropertyDescriptor(_t, prop) {
        const d = Reflect.getOwnPropertyDescriptor(target().impl, prop);
        return d && { ...d, configurable: true };
      },
      set: readOnly("set a property"),
      defineProperty: readOnly("define a property"),
      deleteProperty: readOnly("delete a property"),
    },
  );
}

function removeFrom<E>(list: E[], entry: E): boolean {
  const i = list.indexOf(entry);
  if (i < 0) return false;
  list.splice(i, 1);
  return true;
}

/** Removes every registration of `owner`; returns ids of refs that changed. */
function stripOwner(states: Map<string, RefState>, owner: string): string[] {
  const changed: string[] = [];
  for (const s of states.values()) {
    const lists = [s.provides, s.overrides, s.decorators] as { owner: string }[][];
    const before = lists.reduce((n, l) => n + l.length, 0);
    for (const list of lists) {
      for (let i = list.length - 1; i >= 0; i--) if (list[i]?.owner === owner) list.splice(i, 1);
    }
    if (lists.reduce((n, l) => n + l.length, 0) !== before) changed.push(s.id);
  }
  return changed;
}

function conflictError(refId: string, existing: string, incoming: string, what: string): LoomError {
  return new LoomError(
    "SERVICE_CONFLICT",
    `service "${refId}" already has a ${what} from "${existing}"; "${incoming}" cannot ${what} it too`,
    { pluginIds: [existing, incoming], details: { ref: refId } },
  );
}

type Access = Parameters<typeof checkAccess>[2];

function proxyFor(
  proxies: Map<string, Map<string, object>>,
  s: RefState,
  winners: Winners,
  access: Access,
): object {
  const active = resolve(s, winners).owner;
  if (active !== undefined) checkAccess(s, active, access);
  let byConsumer = proxies.get(s.id);
  if (!byConsumer) proxies.set(s.id, (byConsumer = new Map<string, object>()));
  let proxy = byConsumer.get(access.consumer);
  if (!proxy) {
    proxy = buildProxy(
      s,
      access.consumer,
      () => resolve(s, winners),
      (owner) => {
        checkAccess(s, owner, access);
      },
    );
    byConsumer.set(access.consumer, proxy);
  }
  return proxy;
}

export function createServiceRegistry(opts: ServiceRegistryOptions): ServiceRegistry {
  const { winners = {}, kernelOwner, onError } = opts;
  const states = new Map<string, RefState>();
  const proxies = new Map<string, Map<string, object>>();
  const listeners = new Set<(refId: string) => void>();
  const get = (id: string): RefState => stateOf(states, id);

  function notify(ids: readonly string[]): void {
    const errors: LoomError[] = [];
    for (const id of ids) {
      const s = get(id);
      s.version += 1;
      s.resolved = undefined;
      for (const l of [...listeners]) {
        try {
          l(id);
        } catch (cause) {
          errors.push(
            new LoomError("TAP_FAILED", `service onChange listener failed for "${id}"`, { cause }),
          );
        }
      }
    }
    const [first] = errors;
    if (!first) return;
    if (!onError) throw first;
    for (const e of errors) onError(e);
  }

  function register(
    ref: ServiceRef<unknown>,
    list: (s: RefState) => Impl[],
    entry: Impl,
    what: string,
  ): () => void {
    const s = get(ref.id);
    const existing = list(s)[0];
    if (existing && winners[ref.id] === undefined) {
      throw conflictError(ref.id, existing.owner, entry.owner, what);
    }
    list(s).push(entry);
    notify([ref.id]);
    return () => {
      if (removeFrom(list(s), entry)) notify([ref.id]);
    };
  }

  return {
    provide: (ref, impl, owner) => register(ref, (s) => s.provides, { owner, impl }, "provider"),
    override: (ref, impl, owner) => register(ref, (s) => s.overrides, { owner, impl }, "override"),
    decorate(ref, fn, owner) {
      const s = get(ref.id);
      const d: Decorator = { owner, fn: fn as unknown as (prev: object) => object };
      s.decorators.push(d);
      notify([ref.id]);
      return () => {
        if (removeFrom(s.decorators, d)) notify([ref.id]);
      };
    },
    use<T extends object>(ref: ServiceRef<T>, consumer: string, allowed: ReadonlySet<string>): T {
      return proxyFor(proxies, get(ref.id), winners, { consumer, allowed, kernelOwner }) as T;
    },
    has: (ref) => resolve(get(ref.id), winners).impl !== undefined,
    providerOf: (ref) => resolve(get(ref.id), winners).owner,
    removeOwner(owner) {
      const changed = stripOwner(states, owner);
      if (changed.length > 0) notify(changed);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
