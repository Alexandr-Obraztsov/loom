/// <reference types="node" />
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { LoomError } from "../core/errors.js";
import { validatePlugin } from "../core/manifest.js";
import type { PluginDefinition } from "../core/types.js";

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

/** `pluginId` is passed whenever `loom.id` is known; errors raised before that (package.json unreadable/invalid, no `loom.id`, directory errors) carry `pluginIds: []`. */
const fail = (phase: Phase, message: string, extra: object = {}, cause?: unknown, pluginId?: string): LoomError =>
  new LoomError("MANIFEST_INVALID", message, {
    ...(pluginId === undefined ? {} : { pluginIds: [pluginId] }),
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
  if (entry !== undefined && (typeof entry !== "string" || entry === "")) {
    throw fail("package-json", `"loom.${kind}" in ${dir}/package.json must be a non-empty string`, {}, undefined, loom["id"]);
  }
  return entry === undefined ? { id: loom["id"] } : { id: loom["id"], entry };
}

function resolveEntry(dir: string, id: string, rel: string): string {
  const full = resolve(dir, rel);
  const back = relative(dir, full);
  if (isAbsolute(rel) || back === "" || back === ".." || back.startsWith(`..${sep}`) || isAbsolute(back)) {
    throw fail("package-json", `Entry "${rel}" of "${id}" must stay inside ${dir}`, { entry: rel }, undefined, id);
  }
  return full;
}

async function importDefinition(entry: string, id: string, cacheBust: boolean): Promise<Record<string, unknown>> {
  try {
    const url = pathToFileURL(entry);
    if (cacheBust) url.search = `?v=${String((await stat(entry)).mtimeMs)}`;
    const mod = (await import(/* @vite-ignore */ url.href)) as { default?: unknown };
    const exported = mod.default;
    if (isRecord(exported) && typeof exported["then"] !== "function") return exported;
    if (exported instanceof Promise) {
      throw fail("import", `${entry}: default export is a Promise; export the plugin definition itself`, { entry }, undefined, id);
    }
  } catch (cause) {
    if (cause instanceof LoomError) throw cause;
    throw fail("import", `Failed to import ${entry}`, { entry }, cause, id);
  }
  throw fail("import", `${entry} must have an object as its default export`, { entry }, undefined, id);
}

function validate(imported: Record<string, unknown>, id: string): PluginDefinition {
  try {
    // Shallow copy: reads each getter once, and the imported module's object is never shared with the kernel.
    return validatePlugin({ ...imported });
  } catch (cause) {
    // validatePlugin throws a LoomError with details.issues; check instead of trusting it, and
    // attribute anything else (a throwing getter reached during parsing) with the original as cause.
    const known = cause instanceof LoomError;
    const issues = known && isRecord(cause.details) ? cause.details["issues"] : undefined;
    throw new LoomError("MANIFEST_INVALID", cause instanceof Error ? cause.message : `Invalid plugin definition: ${String(cause)}`, {
      pluginIds: [id],
      details: { phase: "validate", ...(issues === undefined ? {} : { issues }) },
      cause,
    });
  }
}

async function loadPackage(dir: string, opts: LoadOptions): Promise<Outcome> {
  const loom = readLoomField(await readManifest(dir), dir, opts.entry);
  if (!loom?.entry) return { skip: true };
  const entry = resolveEntry(dir, loom.id, loom.entry);
  const imported = await importDefinition(entry, loom.id, opts.cacheBust === true);
  const definition = validate(imported, loom.id);
  if (definition.id !== loom.id) {
    throw fail(
      "validate",
      `Plugin id mismatch in ${dir}: package.json has "${loom.id}", definition has "${definition.id}"`,
      { packageId: loom.id, definitionId: definition.id },
      undefined,
      loom.id,
    );
  }
  return { plugin: { definition, dir, entry } };
}

interface Candidate {
  readonly name: string;
  readonly error?: LoomError;
}

/** Real directories and symlinks to directories; broken or non-directory links become errors. */
async function listPackageDirs(path: string): Promise<Candidate[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const out: Candidate[] = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      out.push({ name: e.name });
    } else if (e.isSymbolicLink()) {
      try {
        if ((await stat(join(path, e.name))).isDirectory()) out.push({ name: e.name });
        else out.push({ name: e.name, error: fail("dir", `${join(path, e.name)} is a link to a non-directory`) });
      } catch (cause) {
        out.push({ name: e.name, error: fail("dir", `${join(path, e.name)} is a broken link`, {}, cause) });
      }
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * Loads plugin packages from the immediate subdirectories of each group directory.
 * Results are ordered by group order, then subdirectory name. A group directory that
 * does not exist (ENOENT) yields nothing; any other read error becomes a failure with
 * `details.phase = "dir"`. A broken package becomes a failure, never a throw.
 * `details.phase` is one of "dir" | "package-json" | "import" | "validate". Symlinks to
 * directories are followed; broken links are failures.
 * Entry containment is lexical (a typo guard, not a sandbox: symlinks inside a package are
 * not resolved). `cacheBust` versions only the entry file, not modules it imports.
 * A package reachable through several paths (symlinks, overlapping groups) loads once, by
 * `realpath`, under the first path in group order.
 */
export async function loadPluginsFromDirs(
  dirs: readonly { path: string }[],
  opts: LoadOptions,
): Promise<LoadResult> {
  const plugins: LoadedPlugin[] = [];
  const failures: LoadFailure[] = [];
  const seen = new Set<string>();
  for (const group of dirs) {
    let names: Candidate[];
    try {
      names = await listPackageDirs(group.path);
    } catch (cause) {
      if (!isEnoent(cause)) {
        failures.push({ dir: group.path, error: fail("dir", `Cannot read plugin directory ${group.path}`, {}, cause) });
      }
      continue;
    }
    for (const { name, error: listError } of names) {
      const dir = join(group.path, name);
      try {
        if (listError) throw listError;
        const real = await realpath(dir);
        if (seen.has(real)) continue;
        seen.add(real);
        const outcome = await loadPackage(dir, opts);
        if ("plugin" in outcome) plugins.push(outcome.plugin);
      } catch (error) {
        const wrapped =
          error instanceof LoomError
            ? error
            : fail("validate", `Unexpected error while loading ${dir}`, {}, error);
        failures.push({ dir, error: wrapped });
      }
    }
  }
  return { plugins, failures };
}
