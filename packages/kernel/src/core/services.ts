import type { Decorator, Impl, RefState } from "./service-helpers.js";
import {
  changedRefs,
  conflictError,
  dispatch,
  holds,
  index,
  isEmpty,
  pickActive,
  rankSort,
  removeFrom,
  reorderAll,
  stripOwner,
} from "./service-helpers.js";
import type { ProxyCache } from "./service-proxy.js";
import { proxyFor } from "./service-proxy.js";
import type { ServiceRef } from "./types.js";

export interface ServiceRegistry {
  provide<T extends object>(ref: ServiceRef<T>, impl: T, owner: string): () => void;
  override<T extends object>(ref: ServiceRef<T>, impl: T, owner: string): () => void;
  decorate<T extends object>(ref: ServiceRef<T>, fn: (prev: T) => T, owner: string): () => void;
  /** Returns a live proxy: always forwards to the currently active implementation. */
  use<T extends object>(ref: ServiceRef<T>, consumer: string, allowed: ReadonlySet<string>): T;
  has(ref: ServiceRef<unknown>): boolean;
  providerOf(ref: ServiceRef<unknown>): string | undefined;
  /**
   * Per-ref counter that increases whenever the active implementation of the ref changes (never for a registration
   * that does not become active). A ref nothing is registered on or consumed from reports 0.
   */
  version(ref: ServiceRef<unknown>): number;
  removeOwner(owner: string): void;
  onChange(listener: (refId: string) => void): () => void;
  /** Re-sorts registrations by `rankOf`; refs whose active implementation changed get a new version. */
  reorder(): void;
  /**
   * Sizes of the registry's internal indexes; they return to their starting values once everything is removed.
   * @internal Diagnostics for tests; not part of the supported API.
   */
  stats(): { readonly refs: number; readonly owners: number; readonly consumers: number };
}

export interface ServiceRegistryOptions {
  readonly winners?: Readonly<Record<string, string>>;
  readonly kernelOwner: string;
  /**
   * Receives listener errors (wrapped as TAP_FAILED); the registration then succeeds and its remover is returned.
   * Without it the errors are thrown after all listeners ran, with the registration already in effect
   * (`removeOwner` reclaims it).
   */
  readonly onError?: (error: unknown) => void;
  /**
   * Orders registrations of one ref (decorator application, fallback provider) by owner rank
   * (lower first), then registration order; absent, registration order only.
   */
  readonly rankOf?: (owner: string) => number;
}

/** The registry's indexes: refs by id, held proxies, and which refs each owner registered on / each consumer uses. */
interface Books {
  readonly states: Map<string, RefState>;
  readonly proxies: ProxyCache;
  readonly registered: Map<string, Set<RefState>>;
  readonly consumed: Map<string, Set<string>>;
  /**
   * States whose proxies were dropped from the cache but may still be held. Pruning a state must not strand such
   * a proxy: when its ref is registered again the same state is revived (weakly held, so it is collected with the proxies).
   */
  readonly escaped: Map<string, WeakRef<RefState>>;
}

function stateOf(b: Books, id: string): RefState {
  let s = b.states.get(id);
  if (!s) {
    s = b.escaped.get(id)?.deref() ?? { id, version: 0, provides: [], overrides: [], decorators: [], resolved: undefined };
    b.escaped.delete(id);
    b.states.set(id, s);
  }
  return s;
}

/** Drops a ref's state once nothing is registered on it and no proxy of it is held. */
function prune(b: Books, s: RefState): void {
  // a stale remover may hold a state that was already dropped and recreated: only ever drop the live one
  if (b.states.get(s.id) === s && isEmpty(s) && !b.proxies.get(s.id)?.size) b.states.delete(s.id);
}

/** Forgets that `owner` registered on `s` once it holds nothing there; drops an owner with no refs left. */
function release(b: Books, s: RefState, owner: string): void {
  const refs = b.registered.get(owner);
  if (!refs || holds(s, owner)) return;
  refs.delete(s);
  if (refs.size === 0) b.registered.delete(owner);
}

/** Forgets every proxy `consumer` holds; returns the states of those refs. */
function dropConsumer(b: Books, consumer: string): RefState[] {
  const touched: RefState[] = [];
  for (const refId of b.consumed.get(consumer) ?? []) {
    const byConsumer = b.proxies.get(refId);
    byConsumer?.delete(consumer);
    if (byConsumer?.size === 0) b.proxies.delete(refId);
    const s = b.states.get(refId);
    if (s) {
      touched.push(s);
      b.escaped.set(refId, new WeakRef(s)); // a proxy of it may still be held by whoever leaked it
    }
  }
  b.consumed.delete(consumer);
  return touched;
}

/** One of the lists of registrations on a ref; `what` names a single-slot kind (provider, override), absent for decorators. */
interface Slot<E> {
  readonly list: (s: RefState) => E[];
  readonly what?: string;
}

const PROVIDER: Slot<Impl> = { list: (s) => s.provides, what: "provider" };
const OVERRIDE: Slot<Impl> = { list: (s) => s.overrides, what: "override" };
const DECORATOR: Slot<Decorator> = { list: (s) => s.decorators };

export function createServiceRegistry(opts: ServiceRegistryOptions): ServiceRegistry {
  const { winners = {}, kernelOwner, onError, rankOf } = opts;
  let seq = 0;
  /** Source of versions: one clock for all refs, so a ref that is dropped and later recreated never repeats a version. */
  let clock = 0;
  const b: Books = { states: new Map(), proxies: new Map(), registered: new Map(), consumed: new Map(), escaped: new Map() };
  const listeners = new Set<(refId: string) => void>();
  const get = (id: string): RefState => stateOf(b, id);
  /** The active registration of `ref`, looked up without creating a state for a ref nobody registered on. */
  const activeOf = (ref: ServiceRef<unknown>): Impl | undefined => {
    const s = b.states.get(ref.id);
    return s && pickActive(s, winners);
  };

  function notify(ids: readonly string[]): void {
    for (const id of ids) {
      const s = get(id);
      s.version = ++clock;
      s.resolved = undefined;
    }
    dispatch(ids, listeners, onError);
  }

  /** Applies `mutate` to the registrations of `refs`, announces the refs whose active implementation moved, tidies the indexes. */
  function change(refs: readonly RefState[], owner: string, mutate: () => void): void {
    const ids = changedRefs(refs, winners, mutate);
    try {
      if (ids.length > 0) notify(ids);
    } finally {
      for (const s of refs) {
        release(b, s, owner);
        prune(b, s);
      }
    }
  }

  /** Adds `entry` to one of the ref's lists; `what` names the single-slot kind (provider, override), absent for decorators. */
  function register<E extends Impl | Decorator>(ref: ServiceRef<unknown>, { list, what }: Slot<E>, entry: E): () => void {
    const s = get(ref.id);
    const existing = list(s)[0];
    if (what && existing && winners[ref.id] === undefined) throw conflictError(ref.id, { existing: existing.owner, incoming: entry.owner }, what);
    index(b.registered, entry.owner, s);
    change([s], entry.owner, () => {
      list(s).push(entry);
      rankSort(list(s), rankOf);
    });
    return () => {
      change([s], entry.owner, () => void removeFrom(list(s), entry));
    };
  }

  function removeOwner(owner: string): void {
    const held = [...(b.registered.get(owner) ?? [])];
    const touched = [...held, ...dropConsumer(b, owner)];
    b.registered.delete(owner);
    change(held, owner, () => {
      stripOwner(held, owner);
    });
    touched.forEach((s) => {
      prune(b, s);
    });
  }

  return {
    provide: (ref, impl, owner) => register(ref, PROVIDER, { owner, impl, seq: seq++ }),
    override: (ref, impl, owner) => register(ref, OVERRIDE, { owner, impl, seq: seq++ }),
    decorate: (ref, fn, owner) =>
      register(ref, DECORATOR, { owner, fn: fn as unknown as (prev: object) => object, seq: seq++ }),
    use<T extends object>(ref: ServiceRef<T>, consumer: string, allowed: ReadonlySet<string>): T {
      index(b.consumed, consumer, ref.id);
      return proxyFor(b.proxies, get(ref.id), { winners, consumer, allowed, kernelOwner }) as T;
    },
    has: (ref) => activeOf(ref) !== undefined,
    providerOf: (ref) => activeOf(ref)?.owner,
    version: (ref) => b.states.get(ref.id)?.version ?? 0,
    removeOwner,
    reorder() {
      const ids = changedRefs([...b.states.values()], winners, () => {
        reorderAll(b.states.values(), rankOf);
      });
      if (ids.length > 0) notify(ids);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    stats: () => ({ refs: b.states.size, owners: b.registered.size, consumers: b.consumed.size }),
  };
}
