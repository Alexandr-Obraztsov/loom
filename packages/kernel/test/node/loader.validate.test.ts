/// <reference types="node" />
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LoomError } from "../../src/core/errors.js";

const thrown = vi.hoisted((): { error: unknown } => ({ error: undefined }));
vi.mock("../../src/core/manifest.js", () => ({
  validatePlugin: (): never => {
    throw thrown.error;
  },
}));

const { loadPluginsFromDirs } = await import("../../src/node/loader.js");

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "loom-loader-validate-"));
  const dir = join(root, "g", "a");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ loom: { id: "a", main: "m.mjs" } }));
  await writeFile(join(dir, "m.mjs"), 'export default { id: "a", version: "1.0.0" };');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function failureFor(error: unknown): Promise<LoomError> {
  thrown.error = error;
  const failure = (await loadPluginsFromDirs([{ path: join(root, "g") }], { entry: "main" })).failures[0];
  if (!failure) throw new Error("expected a failure");
  return failure.error;
}

it.each([
  ["details is not a record", new LoomError("MANIFEST_INVALID", "bad", { details: "text" })],
  ["details has no issues", new LoomError("MANIFEST_INVALID", "bad", { details: { other: 1 } })],
  ["error has no details", new LoomError("MANIFEST_INVALID", "bad")],
])("validate failure when %s still carries phase and pluginIds, without issues", async (_name, cause) => {
  const error = await failureFor(cause);
  expect(error.code).toBe("MANIFEST_INVALID");
  expect(error.message).toBe("bad");
  expect(error.pluginIds).toEqual(["a"]);
  expect(error.details).toEqual({ phase: "validate" });
  expect(error.cause).toBe(cause);
});

it("a non-Error throw is described in the message", async () => {
  const error = await failureFor("oops");
  expect(error.message).toContain("oops");
  expect(error.pluginIds).toEqual(["a"]);
});
