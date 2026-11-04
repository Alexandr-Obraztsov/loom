/// <reference types="node" />
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LoomError } from "../core/errors.js";
import { validatePlugin } from "../core/manifest.js";
import type { PluginDefinition } from "../core/types.js";

type Scope = "builtin" | "user" | "project";
type Phase = "dir" | "package-json" | "import" | "validate";

export interface LoadedPlugin {
  readonly definition: PluginDefinition;
  readonly dir: string;
  readonly entry: string;
}

export interface LoadFailure {
  readonly dir: string;
  readonly error: LoomError;
}

export interface LoadResult {
  readonly plugins: LoadedPlugin[];
  readonly failures: LoadFailure[];
}

export interface LoadOptions {
  readonly entry: "main" | "renderer";
  readonly cacheBust?: boolean;
}

type Outcome = { skip: true } | { plugin: LoadedPlugin };

const fail = (phase: Phase, message: string, extra: object = {}, cause?: unknown): LoomError =>
  new LoomError("MANIFEST_INVALID", message, {
    details: { phase, ...extra },
    ...(cause === undefined ? {} : { cause }),
  });

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isEnoent = (e: unknown): boolean => isRecord(e) && e["code"] === "ENOENT";

async function readManifest(dir: string): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(dir, "package.json"), "utf8");
  } catch (cause) {
    if (isEnoent(cause)) return undefined;
    throw fail("package-json", `Cannot read package.json in ${dir}`, {}, cause);
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (cause) {
    throw fail("package-json", `Invalid JSON in ${join(dir, "package.json")}`, {}, cause);
  }
}

function readLoomField(pkg: unknown, dir: string, kind: "main" | "renderer"): { id: string; entry?: string } | undefined {
  if (!isRecord(pkg) || !("loom" in pkg)) return undefined;
  const loom = pkg["loom"];
  if (!isRecord(loom)) throw fail("package-json", `"loom" in ${dir}/package.json must be an object`);
  if (typeof loom["id"] !== "string") throw fail("package-json", `"loom.id" in ${dir}/package.json must be a string`);
  const entry = loom[kind];
  if (entry !== undefined && typeof entry !== "string") {
    throw fail("package-json", `"loom.${kind}" in ${dir}/package.json must be a string`, { pluginId: loom["id"] });
  }
  return entry === undefined ? { id: loom["id"] } : { id: loom["id"], entry };
}

function resolveEntry(dir: string, id: string, rel: string): string {
  const full = resolve(dir, rel);
  const back = relative(dir, full);
  if (isAbsolute(rel) || back === "" || back.startsWith("..") || isAbsolute(back)) {
    throw fail("package-json", `Entry "${rel}" of "${id}" must stay inside ${dir}`, { pluginId: id, entry: rel });
  }
  return full;
}

async function importDefinition(entry: string, cacheBust: boolean): Promise<Record<string, unknown>> {
  try {
    const url = pathToFileURL(entry);
    if (cacheBust) url.search = `?v=${String((await stat(entry)).mtimeMs)}`;
    const mod = (await import(/* @vite-ignore */ url.href)) as { default?: unknown };
    if (isRecord(mod.default)) return mod.default;
  } catch (cause) {
    throw fail("import", `Failed to import ${entry}`, { entry }, cause);
  }
  throw fail("import", `${entry} must have an object as its default export`, { entry });
}

async function loadPackage(dir: string, scope: Scope, opts: LoadOptions): Promise<Outcome> {
  const loom = readLoomField(await readManifest(dir), dir, opts.entry);
  if (!loom?.entry) return { skip: true };
  const entry = resolveEntry(dir, loom.id, loom.entry);
  const imported = await importDefinition(entry, opts.cacheBust === true);
  // Shallow copy: the imported module's object is never mutated.
  const definition = validatePlugin({ ...imported, scope });
  if (definition.id !== loom.id) {
    throw fail(
      "validate",
      `Plugin id mismatch in ${dir}: package.json has "${loom.id}", definition has "${definition.id}"`,
      { packageId: loom.id, definitionId: definition.id },
    );
  }
  return { plugin: { definition, dir, entry } };
}

/**
 * Loads plugin packages from the immediate subdirectories of each group directory.
 * Results are ordered by group order, then subdirectory name. A group directory that
 * does not exist (ENOENT) yields nothing; any other read error becomes a failure with
 * `details.phase = "dir"`. A broken package becomes a failure, never a throw.
 * `details.phase` is one of "dir" | "package-json" | "import" | "validate".
 */
export async function loadPluginsFromDirs(
  dirs: readonly { path: string; scope: Scope }[],
  opts: LoadOptions,
): Promise<LoadResult> {
  const plugins: LoadedPlugin[] = [];
  const failures: LoadFailure[] = [];
  for (const group of dirs) {
    let names: string[];
    try {
      const entries = await readdir(group.path, { withFileTypes: true });
      names = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch (cause) {
      if (!isEnoent(cause)) {
        failures.push({ dir: group.path, error: fail("dir", `Cannot read plugin directory ${group.path}`, {}, cause) });
      }
      continue;
    }
    for (const name of names) {
      const dir = join(group.path, name);
      try {
        const outcome = await loadPackage(dir, group.scope, opts);
        if ("plugin" in outcome) plugins.push(outcome.plugin);
      } catch (error) {
        failures.push({ dir, error: error as LoomError });
      }
    }
  }
  return { plugins, failures };
}
