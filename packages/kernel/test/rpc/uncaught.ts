import { vi } from "vitest";

/**
 * Runs `body` with `queueMicrotask` wrapped so that errors thrown from microtasks (how an endpoint
 * without a protocol-error sink surfaces a bad message) are collected instead of failing the run.
 */
export async function collectingUncaught(body: () => Promise<void>): Promise<unknown[]> {
  const uncaught: unknown[] = [];
  const real = globalThis.queueMicrotask.bind(globalThis);
  vi.stubGlobal("queueMicrotask", (cb: () => void) => {
    real(() => {
      try {
        cb();
      } catch (e) {
        uncaught.push(e);
      }
    });
  });
  try {
    await body();
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    vi.unstubAllGlobals();
  }
  return uncaught;
}
