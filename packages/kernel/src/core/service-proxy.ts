/*
 * Live service proxies. A proxy forwards every operation to the ref's currently active implementation (base
 * registration plus decorators), checks once per version that the consumer declared a dependency on the
 * provider, and never calls a stale provider. It never mutates a service: writes are refused.
 * Used by `services.ts`; knows nothing about registration.
 */
import { LoomError } from "./errors.js";
import type { RefState, Resolved, ServiceSource, Winners } from "./service-helpers.js";
import { forwarder, pickActive, sameMembers } from "./service-helpers.js";

interface ProxyAccess {
  readonly consumer: string;
  readonly kernelOwner: string;
  allowed: ReadonlySet<string>;
  /** Members of `allowed` when it was last checked: a changed set is noticed even when the caller mutates one Set instance in place. */
  members: readonly string[];
  checkedVersion: number;
}
type Members = Record<PropertyKey, unknown>;

function resolve(s: RefState, winners: Winners): Resolved {
  if (s.resolved?.version === s.version) return s.resolved;
  const entry = pickActive(s, winners);
  const resolved: Resolved = {
    version: s.version,
    owner: entry?.owner,
    base: entry?.impl,
    decorated: undefined,
    failure: undefined,
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

/** What a proxy answers for `then` and `Symbol.toStringTag` while nothing provides the service: it can be awaited and logged. */
function placeholder(id: string): object {
  return { then: undefined, [Symbol.toStringTag]: `LoomService(${id})` };
}

function buildProxy(s: RefState, winners: Winners, access: ProxyAccess): object {
  const { consumer } = access;
  let absent: object | undefined;
  const resolveChecked = (prop: PropertyKey | undefined): object => {
    const r = resolve(s, winners);
    if (r.base === undefined || r.owner === undefined) {
      if (prop === "then" || prop === Symbol.toStringTag) return (absent ??= placeholder(s.id));
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
    return materialize(s, r as Resolved & { base: object });
  };
  /** The active (decorated) implementation; afterwards `s.resolved` is its Resolved. Hot path: no calls, no allocation. */
  const current = (prop?: PropertyKey): object => {
    const r = s.resolved;
    if (r?.version === s.version && access.checkedVersion === r.version && r.decorated !== undefined) return r.decorated;
    return resolveChecked(prop);
  };
  const source: ServiceSource = { id: s.id, current };
  const readOnly = (what: string) => (): never => {
    throw new TypeError(`cannot ${what} on service "${s.id}" through its proxy`);
  };
  /** This proxy's forwarding functions for one Resolved (so their identity changes with the implementation). */
  let wrappersOf: Resolved | undefined;
  let wrappers: Map<PropertyKey, unknown> | undefined;
  /** One-entry cache in front of `wrappers`: repeated calls of one method skip the map. */
  let lastProp: PropertyKey | undefined;
  let lastWrapper: unknown;
  const wrapper = (prop: PropertyKey, raw: (...args: unknown[]) => unknown): unknown => {
    if (wrappersOf !== s.resolved) {
      wrappersOf = s.resolved;
      wrappers = undefined;
      lastProp = undefined;
    } else if (prop === lastProp) return lastWrapper;
    wrappers ??= new Map();
    let w = wrappers.get(prop);
    if (!w) wrappers.set(prop, (w = forwarder(raw, prop, source)));
    lastProp = prop;
    lastWrapper = w;
    return w;
  };
  return new Proxy<object>(
    {},
    {
      get(_t, prop) {
        // `impl[prop]` is `Reflect.get(impl, prop, impl)`, and markedly faster on this hot path
        const raw = (current(prop) as Members)[prop];
        return typeof raw === "function" ? wrapper(prop, raw as (...args: unknown[]) => unknown) : raw;
      },
      has: (_t, prop) => Reflect.has(current(), prop),
      ownKeys: () => Reflect.ownKeys(current()),
      // keeps a class instance's prototype chain visible through the proxy (inherited methods, `instanceof`)
      getPrototypeOf: () => Reflect.getPrototypeOf(current()),
      getOwnPropertyDescriptor(_t, prop) {
        const d = Reflect.getOwnPropertyDescriptor(current(), prop);
        return d && { ...d, configurable: true };
      },
      set: readOnly("set a property"),
      defineProperty: readOnly("define a property"),
      deleteProperty: readOnly("delete a property"),
      // refused outright: a non-extensible target would pin `ownKeys` to the (empty) target's keys
      preventExtensions: readOnly("prevent extensions"),
    },
  );
}

export type ProxyCache = Map<string, Map<string, CachedProxy>>;
type CachedProxy = { proxy: object; access: ProxyAccess };

/** Who asks for the proxy, and what decides which registration is active. */
export interface ProxyRequest {
  readonly winners: Winners;
  readonly consumer: string;
  readonly allowed: ReadonlySet<string>;
  readonly kernelOwner: string;
}

/** The live proxy of `s` for one consumer, created once and re-validated when the consumer's allowed set changed. */
export function proxyFor(proxies: ProxyCache, s: RefState, request: ProxyRequest): object {
  const { winners, consumer, allowed, kernelOwner } = request;
  let byConsumer = proxies.get(s.id);
  if (!byConsumer) proxies.set(s.id, (byConsumer = new Map<string, CachedProxy>()));
  let cached = byConsumer.get(consumer);
  if (!cached) {
    const access: ProxyAccess = { consumer, kernelOwner, allowed, members: [...allowed], checkedVersion: -1 };
    cached = { proxy: buildProxy(s, winners, access), access };
    byConsumer.set(consumer, cached);
  } else if (!sameMembers(cached.access.members, allowed)) {
    cached.access.allowed = allowed;
    cached.access.members = [...allowed];
    cached.access.checkedVersion = -1;
  }
  const active = resolve(s, winners).owner;
  if (active !== undefined) checkAccess(s, active, cached.access);
  return cached.proxy;
}
