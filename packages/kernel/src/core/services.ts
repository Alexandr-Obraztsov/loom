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
  /** Per-ref counter that increases whenever the active implementation of the ref changes. */
  version(ref: ServiceRef<unknown>): number;
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
  /** Active registration's impl before decorators; undefined when there is no provider. */
  readonly base: object | undefined;
  decorated?: object;
  failure?: LoomError;
  readonly wrappers: Map<PropertyKey, unknown>;
}
interface ProxyAccess {
  readonly consumer: string;
  readonly kernelOwner: string;
  allowed: ReadonlySet<string>;
  checkedVersion: number;
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
  const resolved: Resolved = {
    version: s.version,
    owner: entry?.owner,
    base: entry?.impl,
    wrappers: new Map(),
  };
  s.resolved = resolved;
  return resolved;
}

/** Runs decorators once per version; a failure is cached for that version. */
function materialize(s: RefState, r: Resolved & { base: object }): object {
  if (r.failure) throw r.failure;
  if (r.decorated) return r.decorated;
  let impl = r.base;
  for (const d of s.decorators) {
    try {
      impl = d.fn(impl);
    } catch (cause) {
      r.failure = new LoomError(
        "TAP_FAILED",
        `decorator of "${d.owner}" for service "${s.id}" failed`,
        {
          pluginIds: [d.owner],
          details: { ref: s.id },
          cause,
        },
      );
      throw r.failure;
    }
  }
  r.decorated = impl;
  return impl;
}

function checkAccess(s: RefState, owner: string, access: ProxyAccess): void {
  const { consumer, allowed, kernelOwner } = access;
  if (owner === consumer || owner === kernelOwner || allowed.has(owner)) return;
  throw new LoomError(
    "UNDECLARED_DEPENDENCY",
    `"${consumer}" uses service "${s.id}" provided by "${owner}" without declaring a dependency on it`,
    { pluginIds: [consumer], details: { ref: s.id, provider: owner } },
  );
}

function buildProxy(s: RefState, winners: Winners, access: ProxyAccess): object {
  const { consumer } = access;
  const current = (): { r: Resolved; impl: object } => {
    const r = resolve(s, winners);
    if (r.base === undefined || r.owner === undefined) {
      throw new LoomError(
        "SERVICE_MISSING",
        `service "${s.id}" has no active provider (used by "${consumer}")`,
        { pluginIds: [consumer], details: { ref: s.id } },
      );
    }
    if (access.checkedVersion !== r.version) {
      checkAccess(s, r.owner, access);
      access.checkedVersion = r.version;
    }
    return { r, impl: materialize(s, r as Resolved & { base: object }) };
  };
  const readOnly = (what: string) => (): never => {
    throw new TypeError(`cannot ${what} on service "${s.id}" through its proxy`);
  };
  const wrapper = (r: Resolved, prop: PropertyKey): unknown => {
    let w = r.wrappers.get(prop);
    if (!w) {
      w = (...args: unknown[]): unknown => {
        const cur = current().impl;
        const fn: unknown = Reflect.get(cur, prop, cur);
        if (typeof fn !== "function") {
          throw new TypeError(`"${String(prop)}" of service "${s.id}" is no longer a function`);
        }
        const result: unknown = Reflect.apply(fn, cur, args);
        return result;
      };
      r.wrappers.set(prop, w);
    }
    return w;
  };
  return new Proxy<object>(
    {},
    {
      get(_t, prop) {
        const { r, impl } = current();
        const raw: unknown = Reflect.get(impl, prop, impl);
        return typeof raw === "function" ? wrapper(r, prop) : raw;
      },
      has: (_t, prop) => Reflect.has(current().impl, prop),
      ownKeys: () => Reflect.ownKeys(current().impl),
      getOwnPropertyDescriptor(_t, prop) {
        const d = Reflect.getOwnPropertyDescriptor(current().impl, prop);
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

function conflictError(refId: string, existing: string, incoming: string, what: string): LoomError {
  return new LoomError(
    "SERVICE_CONFLICT",
    `service "${refId}" already has a ${what} from "${existing}"; "${incoming}" cannot ${what} it too`,
    { pluginIds: [existing, incoming], details: { ref: refId } },
  );
}

type CachedProxy = { proxy: object; access: ProxyAccess };
type ProxyCache = Map<string, Map<string, CachedProxy>>;

function proxyFor(
  proxies: ProxyCache,
  s: RefState,
  winners: Winners,
  request: { consumer: string; allowed: ReadonlySet<string>; kernelOwner: string },
): object {
  let byConsumer = proxies.get(s.id);
  if (!byConsumer) proxies.set(s.id, (byConsumer = new Map<string, CachedProxy>()));
  let cached = byConsumer.get(request.consumer);
  if (!cached) {
    const access: ProxyAccess = { ...request, checkedVersion: -1 };
    cached = { proxy: buildProxy(s, winners, access), access };
    byConsumer.set(request.consumer, cached);
  } else if (cached.access.allowed !== request.allowed) {
    cached.access.allowed = request.allowed;
    cached.access.checkedVersion = -1;
  }
  const active = resolve(s, winners).owner;
  if (active !== undefined) checkAccess(s, active, cached.access);
  return cached.proxy;
}

export function createServiceRegistry(opts: ServiceRegistryOptions): ServiceRegistry {
  const { winners = {}, kernelOwner, onError } = opts;
  const states = new Map<string, RefState>();
  const proxies: ProxyCache = new Map();
  const listeners = new Set<(refId: string) => void>();
  const get = (id: string): RefState => stateOf(states, id);

  function notify(ids: readonly string[]): void {
    for (const id of ids) {
      const s = get(id);
      s.version += 1;
      s.resolved = undefined;
    }
    const errors: unknown[] = [];
    for (const id of ids) {
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
    const failures = onError ? deliver(errors, onError) : errors;
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        `${String(failures.length)} service onChange listeners failed`,
      );
    }
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
    has: (ref) => resolve(get(ref.id), winners).base !== undefined,
    providerOf: (ref) => resolve(get(ref.id), winners).owner,
    version: (ref) => get(ref.id).version,
    removeOwner(owner) {
      for (const byConsumer of proxies.values()) byConsumer.delete(owner);
      const changed = stripOwner(states, owner);
      if (changed.length > 0) notify(changed);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
