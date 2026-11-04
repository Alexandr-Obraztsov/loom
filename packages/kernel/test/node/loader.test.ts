/// <reference types="node" />
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LoomError } from "../../src/core/errors.js";
import { loadPluginsFromDirs } from "../../src/node/loader.js";

let root: string;

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

const group = (name: string, scope: "builtin" | "user" | "project" = "user"): { path: string; scope: "builtin" | "user" | "project" } => ({
  path: join(root, name),
  scope,
});

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

  it("scope is taken from the directory group", async () => {
    await writePkg("b", "a", { loom: { id: "a", main: "m.mjs" }, files: { "m.mjs": def("a", "1.0.0", ', scope: "project"') } });
    await writePkg("p", "c", { loom: { id: "c", main: "m.mjs" }, files: { "m.mjs": def("c") } });
    const result = await loadPluginsFromDirs([group("b", "builtin"), group("p", "project")], { entry: "main" });
    expect(result.plugins.map((p) => [p.definition.id, p.definition.scope])).toEqual([
      ["a", "builtin"],
      ["c", "project"],
    ]);
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
