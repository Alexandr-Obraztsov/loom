/**
 * Typed access to the standard globals rpc relies on (structuredClone, queueMicrotask, timers,
 * AbortController). The kernel compiles against the plain ES2023 lib, without DOM or Node types,
 * so these are declared minimally here and looked up on `globalThis` at call time (fake timers
 * installed later are honoured).
 */

/** The part of a standard `AbortSignal` the RPC layer uses; DOM and Node signals satisfy it. */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

export interface AbortControllerLike {
  readonly signal: AbortSignalLike;
  abort(): void;
}

interface Platform {
  structuredClone<T>(value: T): T;
  queueMicrotask(cb: () => void): void;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  AbortController: new () => AbortControllerLike;
}

const platform = globalThis as unknown as Platform;

export function clone<T>(value: T): T {
  return platform.structuredClone(value);
}

export function microtask(cb: () => void): void {
  platform.queueMicrotask(cb);
}

export function startTimer(cb: () => void, ms: number): unknown {
  return platform.setTimeout(cb, ms);
}

export function stopTimer(handle: unknown): void {
  platform.clearTimeout(handle);
}

export function createAbortController(): AbortControllerLike {
  return new platform.AbortController();
}
