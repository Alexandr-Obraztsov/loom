/// <reference types="node" />
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LoomError } from "../../src/core/errors.js";
import { loadPluginsFromDirs } from "../../src/node/loader.js";

let root: string;

/** Symlinks need privileges on Windows (EPERM); probe once and skip the symlink tests where unavailable. */
async function probeSymlinks(): Promise<boolean> {
  if (process.platform === "win32") return false;
  const probe = await mkdtemp(join(tmpdir(), "loom-symlink-probe-"));
  try {
    await symlink(probe, join(probe, "l"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}
const canSymlink = await probeSymlinks();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "loom-loader-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface PkgOptions {
  loom?: unknown;
  rawPackageJson?: string;
  files?: Record<string, string>;
}

async function writePkg(group: string, name: string, opts: PkgOptions): Promise<string> {
  const dir = join(root, group, name);
  await mkdir(dir, { recursive: true });
  const json = opts.rawPackageJson ?? JSON.stringify({ name, ...("loom" in opts ? { loom: opts.loom } : {}) });
  await writeFile(join(dir, "package.json"), json);
  for (const [file, content] of Object.entries(opts.files ?? {})) {
    await mkdir(join(dir, file, ".."), { recursive: true });
    await writeFile(join(dir, file), content);
  }
  return dir;
}

const def = (id: string, version = "1.0.0", extra = ""): string =>
  `export default { id: "${id}", version: "${version}"${extra} };\n`;

const group = (name: string): { path: string } => ({ path: join(root, name) });

function failureOf(result: Awaited<ReturnType<typeof loadPluginsFromDirs>>, index = 0): LoomError {
  const failure = result.failures[index];
  if (!failure) throw new Error("expected a failure");
  return failure.error;
}

describe("loadPluginsFromDirs", () => {
  it("loads a plugin with main entry", async () => {
    const dir = await writePkg("g", "a", { loom: { id: "a", main: "main.mjs" }, files: { "main.mjs": def("a") } });
    const result = await loadPluginsFromDirs([group("g")], { entry: "main" });
    expect(result.failures).toEqual([]);
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]?.definition.id).toBe("a");
    expect(result.plugins[0]?.dir).toBe(dir);
    expect(result.plugins[0]?.entry).toBe(join(dir, "main.mjs"));
  });

  it("skips directories without loom field", async () => {
    await writePkg("g", "plain", { files: { "main.mjs": def("x") } });
    await mkdir(join(root, "g", "nopkg"));
    await writeFile(join(root, "g", "file.txt"), "not a dir");
    const result = await loadPluginsFromDirs([group("g")], { entry: "main" });
    expect(result).toEqual({ plugins: [], failures: [] });
  });

  it("reports id mismatch as MANIFEST_INVALID failure", async () => {
    const dir = await writePkg("g", "a", { loom: { id: "a", main: "m.mjs" }, files: { "m.mjs": def("b") } });
    const result = await loadPluginsFromDirs([group("g")], { entry: "main" });
    expect(result.plugins).toEqual([]);
    expect(result.failures[0]?.dir).toBe(dir);
    const error = failureOf(result);
    expect(error.code).toBe("MANIFEST_INVALID");
    expect(error.details).toMatchObject({ phase: "validate", packageId: "a", definitionId: "b" });
    expect(error.pluginIds).toEqual(["a"]);
  });

  it("reports import error as failure and still loads others", async () => {
    await writePkg("g", "bad", { loom: { id: "bad", main: "m.mjs" }, files: { "m.mjs": "export default {" } });
    await writePkg("g", "throws", { loom: { id: "throws", main: "m.mjs" }, files: { "m.mjs": 'throw new Error("boom");' } });
    await writePkg("g", "ok", { loom: { id: "ok", main: "m.mjs" }, files: { "m.mjs": def("ok") } });
    const result = await loadPluginsFromDirs([group("g")], { entry: "main" });
    expect(result.plugins.map((p) => p.definition.id)).toEqual(["ok"]);
    expect(result.failures).toHaveLength(2);
    for (const [i, message] of [[0, undefined], [1, "boom"]] as const) {
      const error = failureOf(result, i);
      expect(error.code).toBe("MANIFEST_INVALID");
      expect(error.details).toMatchObject({ phase: "import" });
      if (message) expect((error.cause as Error).message).toBe(message);
    }
  });

  it("missing entry for requested process is skipped, not a failure", async () => {
    await writePkg("g", "a", { loom: { id: "a", main: "m.mjs" }, files: { "m.mjs": def("a") } });
    const result = await loadPluginsFromDirs([group("g")], { entry: "renderer" });
    expect(result).toEqual({ plugins: [], failures: [] });
  });

  it("cacheBust loads the new code after file change", async () => {
    const file = join(root, "g", "a", "m.mjs");
    await writePkg("g", "a", { loom: { id: "a", main: "m.mjs" }, files: { "m.mjs": def("a", "1.0.0") } });
    await utimes(file, 1000, 1000);
    const first = await loadPluginsFromDirs([group("g")], { entry: "main", cacheBust: true });
    expect(first.plugins[0]?.definition.version).toBe("1.0.0");
    await writeFile(file, def("a", "2.0.0"));
    await utimes(file, 2000, 2000);
    const second = await loadPluginsFromDirs([group("g")], { entry: "main", cacheBust: true });
    expect(second.plugins[0]?.definition.version).toBe("2.0.0");
  });

  it("stamps nothing onto the definition and rejects a scope key as unknown", async () => {
    await writePkg("b", "a", { loom: { id: "a", main: "m.mjs" }, files: { "m.mjs": def("a") } });
    await writePkg("p", "c", { loom: { id: "c", main: "m.mjs" }, files: { "m.mjs": def("c", "1.0.0", ', scope: "project"') } });
    const result = await loadPluginsFromDirs([group("b"), group("p")], { entry: "main" });
    expect(result.plugins.map((p) => Object.keys(p.definition).sort())).toEqual([["id", "version"]]);
    expect(failureOf(result).code).toBe("MANIFEST_INVALID");
    expect(JSON.stringify(failureOf(result).details)).toContain("scope");
  });

  it("orders results by group, then directory name", async () => {
    await writePkg("g1", "z", { loom: { id: "z", main: "m.mjs" }, files: { "m.mjs": def("z") } });
    await writePkg("g1", "b", { loom: { id: "b", main: "m.mjs" }, files: { "m.mjs": def("b") } });
    await writePkg("g2", "a", { loom: { id: "a", main: "m.mjs" }, files: { "m.mjs": def("a") } });
    const result = await loadPluginsFromDirs([group("g1"), group("g2")], { entry: "main" });
    expect(result.plugins.map((p) => p.definition.id)).toEqual(["b", "z", "a"]);
  });
});

describe("loadPluginsFromDirs error handling", () => {
  it("treats a missing group directory as empty", async () => {
    expect(await loadPluginsFromDirs([group("absent")], { entry: "main" })).toEqual({ plugins: [], failures: [] });
  });

  it("reports a non-directory group path as a failure", async () => {
    await writeFile(join(root, "afile"), "x");
    const result = await loadPluginsFromDirs([group("afile")], { entry: "main" });
    expect(result.failures[0]?.dir).toBe(join(root, "afile"));
    expect(failureOf(result).details).toMatchObject({ phase: "dir" });
  });

  it("reports malformed package.json and loom fields with phase package-json", async () => {
    await writePkg("g", "a-json", { rawPackageJson: "{nope" });
    await writePkg("g", "b-null", { loom: null });
    await writePkg("g", "c-array", { loom: [] });
    await writePkg("g", "d-id", { loom: { id: 5, main: "m.mjs" } });
    await writePkg("g", "e-main", { loom: { id: "e", main: 5 } });
    const result = await loadPluginsFromDirs([group("g")], { entry: "main" });
    expect(result.failures).toHaveLength(5);
    result.failures.forEach((f) => {
      expect(f.error.code).toBe("MANIFEST_INVALID");
      expect(f.error.details).toMatchObject({ phase: "package-json" });
    });
  });

  it("reports an unreadable package.json as package-json failure", async () => {
    await mkdir(join(root, "g", "a", "package.json"), { recursive: true });
    const result = await loadPluginsFromDirs([group("g")], { entry: "main" });
    expect(failureOf(result).details).toMatchObject({ phase: "package-json" });
  });

  it("rejects entry paths escaping the package directory", async () => {
    await writePkg("g", "up", { loom: { id: "up", main: "../outside.mjs" }, files: { "../outside.mjs": def("up") } });
    await writePkg("g", "abs", { loom: { id: "abs", main: join(root, "g", "up", "..", "outside.mjs") } });
    const result = await loadPluginsFromDirs([group("g")], { entry: "main" });
    expect(result.plugins).toEqual([]);
    expect(result.failures).toHaveLength(2);
    result.failures.forEach((f) => {
      expect(f.error.details).toMatchObject({ phase: "package-json" });
    });
    expect(result.failures.map((f) => f.error.pluginIds)).toEqual([["abs"], ["up"]]);
  });

  it("reports a missing or non-object default export", async () => {
    await writePkg("g", "none", { loom: { id: "none", main: "m.mjs" }, files: { "m.mjs": "export const x = 1;" } });
    await writePkg("g", "str", { loom: { id: "str", main: "m.mjs" }, files: { "m.mjs": 'export default "s";' } });
    await writePkg("g", "nul", { loom: { id: "nul", main: "m.mjs" }, files: { "m.mjs": "export default null;" } });
    const result = await loadPluginsFromDirs([group("g")], { entry: "main" });
    expect(result.failures).toHaveLength(3);
    result.failures.forEach((f) => {
      expect(f.error.details).toMatchObject({ phase: "import" });
    });
  });

  it("reports an invalid definition as the validatePlugin error", async () => {
    await writePkg("g", "a", { loom: { id: "a", main: "m.mjs" }, files: { "m.mjs": def("a", "not-semver") } });
    const result = await loadPluginsFromDirs([group("g")], { entry: "main" });
    expect(failureOf(result).code).toBe("MANIFEST_INVALID");
    expect(failureOf(result).message).toContain("invalid semver version");
    expect(failureOf(result).details).toMatchObject({ phase: "validate" });
    expect(failureOf(result).cause).toBeInstanceOf(LoomError);
  });

  it("loads the renderer entry when requested", async () => {
    await writePkg("g", "a", {
      loom: { id: "a", main: "m.mjs", renderer: "r.mjs" },
      files: { "m.mjs": def("a", "1.0.0"), "r.mjs": def("a", "2.0.0") },
    });
    const result = await loadPluginsFromDirs([group("g")], { entry: "renderer" });
    expect(result.plugins[0]?.definition.version).toBe("2.0.0");
  });
});

describe("loadPluginsFromDirs symlinks and edge cases", () => {
  it.skipIf(!canSymlink)("symlinked package directory is loaded", async () => {
    const target = await writePkg("store", "real", { loom: { id: "real", main: "m.mjs" }, files: { "m.mjs": def("real") } });
    await mkdir(join(root, "g"));
    await symlink(target, join(root, "g", "linked"), "dir");
    const result = await loadPluginsFromDirs([group("g")], { entry: "main" });
    expect(result.failures).toEqual([]);
    expect(result.plugins.map((p) => p.definition.id)).toEqual(["real"]);
  });

  it.skipIf(!canSymlink)("broken symlink is reported as a failure", async () => {
    await mkdir(join(root, "g"));
    await symlink(join(root, "nowhere"), join(root, "g", "dead"), "dir");
    await writeFile(join(root, "target.txt"), "x");
    await symlink(join(root, "target.txt"), join(root, "g", "tofile"));
    const result = await loadPluginsFromDirs([group("g")], { entry: "main" });
    expect(result.failures.map((f) => f.dir)).toEqual([join(root, "g", "dead"), join(root, "g", "tofile")]);
    result.failures.forEach((f) => {
      expect(f.error.details).toMatchObject({ phase: "dir" });
    });
  });

  it("default export with a throwing getter becomes a MANIFEST_INVALID failure", async () => {
    const src = 'export default { id: "a", version: "1.0.0", get extensions() { throw new Error("getter"); } };';
    await writePkg("g", "a", { loom: { id: "a", main: "m.mjs" }, files: { "m.mjs": src } });
    const result = await loadPluginsFromDirs([group("g")], { entry: "main" });
    expect(failureOf(result).code).toBe("MANIFEST_INVALID");
    expect(failureOf(result).details).toMatchObject({ phase: "validate" });
    expect((failureOf(result).cause as Error).message).toBe("getter");
    expect(failureOf(result).pluginIds).toEqual(["a"]);
  });

  it("entry named ..hidden.mjs inside the package is allowed", async () => {
    await writePkg("g", "a", { loom: { id: "a", main: "..hidden.mjs" }, files: { "..hidden.mjs": def("a") } });
    const result = await loadPluginsFromDirs([group("g")], { entry: "main" });
    expect(result.failures).toEqual([]);
    expect(result.plugins).toHaveLength(1);
  });

  it("accepts an entry starting with .. and rejects ../x.js", async () => {
    await writePkg("g", "ok", { loom: { id: "ok", main: "..hidden/main.js" }, files: { "..hidden/main.js": def("ok") } });
    await writePkg("g", "up", { loom: { id: "up", main: "../x.js" }, files: { "../x.js": def("up") } });
    const result = await loadPluginsFromDirs([group("g")], { entry: "main" });
    expect(result.plugins.map((p) => p.definition.id)).toEqual(["ok"]);
    expect(failureOf(result).details).toMatchObject({ phase: "package-json", entry: "../x.js" });
  });

  it("an empty entry string is MANIFEST_INVALID, not a silent skip", async () => {
    await writePkg("g", "empty", { loom: { id: "empty", main: "" } });
    const result = await loadPluginsFromDirs([group("g")], { entry: "main" });
    expect(result.plugins).toEqual([]);
    expect(failureOf(result).code).toBe("MANIFEST_INVALID");
    expect(failureOf(result).message).toContain("non-empty string");
    expect(failureOf(result).pluginIds).toEqual(["empty"]);
  });

  it("a Promise default export says to export the definition itself", async () => {
    const src = 'export default Promise.resolve({ id: "prom", version: "1.0.0" });';
    await writePkg("g", "prom", { loom: { id: "prom", main: "m.mjs" }, files: { "m.mjs": src } });
    const error = failureOf(await loadPluginsFromDirs([group("g")], { entry: "main" }));
    expect(error.code).toBe("MANIFEST_INVALID");
    expect(error.message).toContain("default export is a Promise; export the plugin definition itself");
    expect(error.pluginIds).toEqual(["prom"]);
  });

  it("a non-Error throw inside validation still becomes a validate failure", async () => {
    const src = 'export default { id: "a", version: "1.0.0", extensions: [{ get id() { throw "plain"; }, factory() {} }] };';
    await writePkg("g", "a", { loom: { id: "a", main: "m.mjs" }, files: { "m.mjs": src } });
    const error = failureOf(await loadPluginsFromDirs([group("g")], { entry: "main" }));
    expect(error.code).toBe("MANIFEST_INVALID");
    expect(error.details).toMatchObject({ phase: "validate" });
    expect(error.cause).toBe("plain");
    expect(error.pluginIds).toEqual(["a"]);
  });

  it.skipIf(!canSymlink)("one package linked under two names loads once (by realpath)", async () => {
    const target = await writePkg("store", "real", { loom: { id: "real", main: "m.mjs" }, files: { "m.mjs": def("real") } });
    await mkdir(join(root, "g"));
    await symlink(target, join(root, "g", "a-link"), "dir");
    await symlink(target, join(root, "g", "b-link"), "dir");
    const result = await loadPluginsFromDirs([group("g"), group("store")], { entry: "main" });
    expect(result.failures).toEqual([]);
    expect(result.plugins.map((p) => p.dir)).toEqual([join(root, "g", "a-link")]);
  });
});
