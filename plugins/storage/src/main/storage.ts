import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NamespaceStore, Storage } from "../api.js";

/** Namespaces become file names; keep them small, lowercase and path-free. */
const NS_PATTERN = /^[a-z0-9._-]+$/;

export interface StorageDeps {
  readonly dataDir: string;
  onCorrupt(ns: string, backup: string): void;
}

interface ScopeState {
  data?: Map<string, unknown>;
  queue: Promise<unknown>;
}

const isMissing = (error: unknown): boolean => (error as { code?: string }).code === "ENOENT";

/** A JSON object body; `undefined` when the text is JSON but not an object. */
function parseRecord(text: string): Map<string, unknown> | undefined {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return new Map(Object.entries(value as Record<string, unknown>));
}

/** Runs `job` after every earlier job of the same namespace; a failed job does not stall the queue. */
function enqueue<T>(state: ScopeState, job: () => Promise<T>): Promise<T> {
  const next = state.queue.then(job, job);
  state.queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** Namespaced JSON-file storage with atomic writes (temp + rename) serialized per namespace. */
export function createStorage(deps: StorageDeps): Storage {
  const dir = join(deps.dataDir, "storage");
  const scopes = new Map<string, ScopeState>();
  let dirReady: Promise<void> | undefined;

  const stateOf = (ns: string): ScopeState => {
    let state = scopes.get(ns);
    if (!state) {
      state = { queue: Promise.resolve() };
      scopes.set(ns, state);
    }
    return state;
  };

  /** Reads `<ns>.json` once per boot; a corrupt file is backed up and the namespace starts empty. */
  const load = async (ns: string, state: ScopeState): Promise<Map<string, unknown>> => {
    if (state.data) return state.data;
    const file = join(dir, `${ns}.json`);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if (!isMissing(error)) throw error;
      return (state.data = new Map());
    }
    let parsed: Map<string, unknown> | undefined;
    try {
      parsed = parseRecord(text);
    } catch {
      // JSON.parse only throws SyntaxError: a corrupt body
    }
    if (parsed) {
      state.data = parsed;
    } else {
      const backup = `${file}.corrupt-${String(Date.now())}`;
      await rename(file, backup);
      state.data = new Map();
      deps.onCorrupt(ns, backup);
    }
    return state.data;
  };

  /** mkdir returns the first path created; only its completion matters here. */
  const ensureDir = (): Promise<void> => {
    dirReady ??= mkdir(dir, { recursive: true }).then(() => undefined);
    return dirReady;
  };

  const persist = async (ns: string, data: Map<string, unknown>): Promise<void> => {
    await ensureDir();
    const file = join(dir, `${ns}.json`);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(Object.fromEntries(data)));
    await rename(tmp, file);
  };

  return {
    scope(ns) {
      if (!NS_PATTERN.test(ns)) throw new Error(`Invalid storage namespace: ${JSON.stringify(ns)}`);
      const state = stateOf(ns);
      const store: NamespaceStore = {
        get: <T>(key: string) =>
          enqueue(state, async () => (await load(ns, state)).get(key) as T | undefined),
        set: (key: string, value: unknown) =>
          enqueue(state, async () => {
            const data = await load(ns, state);
            data.set(key, value);
            await persist(ns, data);
          }),
        delete: (key: string) =>
          enqueue(state, async () => {
            const data = await load(ns, state);
            if (!data.delete(key)) return;
            await persist(ns, data);
          }),
        keys: () => enqueue(state, async () => [...(await load(ns, state)).keys()].sort()),
      };
      return store;
    },
  };
}
