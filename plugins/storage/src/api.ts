import { createServiceRef } from "@loom/sdk";
import type { ServiceRef } from "@loom/sdk";

/** One JSON-backed namespace: get/set/delete/keys over `<dataDir>/storage/<ns>.json`. */
export interface NamespaceStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export interface Storage {
  /** Throws on a namespace that does not match `/^[a-z0-9._-]+$/`. */
  scope(ns: string): NamespaceStore;
}

export const StorageRef: ServiceRef<Storage> = createServiceRef<Storage>("storage");
