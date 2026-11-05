import type { HookRef, Kernel, ServiceRef } from "@loom/kernel";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext } from "react";

const KernelContext = createContext<Kernel | undefined>(undefined);

export function KernelProvider(props: { kernel: Kernel; children: ReactNode }): ReactNode {
  return <KernelContext value={props.kernel}>{props.children}</KernelContext>;
}

export function useKernel(): Kernel {
  const kernel = useContext(KernelContext);
  if (!kernel) throw new Error("useKernel must be used inside <KernelProvider>");
  return kernel;
}

/** Services are live proxies, so the result stays valid across overrides. */
export function useService<T extends object>(ref: ServiceRef<T>): T {
  return useKernel().services.use(ref);
}

export function useHookRunner<C, R>(hook: HookRef<C, R>): (ctx: C, fallback: (c: C) => R) => R {
  const kernel = useKernel();
  return useCallback((ctx, fallback) => kernel.run(hook, ctx, fallback), [kernel, hook]);
}
