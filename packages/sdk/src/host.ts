import { createServiceRef } from "@loom/kernel";
import type { RpcEndpoint, ServiceRef } from "@loom/kernel";

/** What the Electron host tells plugins about the process they run in. */
export interface Host {
  readonly process: "main" | "renderer";
  readonly projectDir: string;
  readonly dataDir: string;
  /** The rpc endpoint to the other process. */
  readonly endpoint: RpcEndpoint;
}

/** Provided by the host through `createKernel({ hostServices })`; usable by any plugin without `dependsOn`. */
export const HostRef: ServiceRef<Host> = createServiceRef<Host>("host");
