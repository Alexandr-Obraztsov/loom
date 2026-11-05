import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveProjectDir } from "../src/main/project.js";

const scratch = (): string => mkdtempSync(join(tmpdir(), "loom-project-"));

describe("resolveProjectDir", () => {
  it("prefers LOOM_PROJECT_DIR and never asks", async () => {
    const dir = await resolveProjectDir({
      env: "/from/env",
      lastFile: join(scratch(), "last-project.json"),
      pick: () => Promise.reject(new Error("must not ask")),
    });
    expect(dir).toBe("/from/env");
  });

  it("uses the last used folder while it still exists", async () => {
    const root = scratch();
    const lastFile = join(root, "last-project.json");
    writeFileSync(lastFile, JSON.stringify({ dir: root }));
    const dir = await resolveProjectDir({
      env: undefined,
      lastFile,
      pick: () => Promise.resolve("/x"),
    });
    expect(dir).toBe(root);
  });

  it("asks when the last folder is gone or the file is corrupt, and remembers the pick", async () => {
    const root = scratch();
    const lastFile = join(root, "last-project.json");
    writeFileSync(lastFile, JSON.stringify({ dir: join(root, "gone") }));
    const picked = await resolveProjectDir({
      env: undefined,
      lastFile,
      pick: () => Promise.resolve(root),
    });
    expect(picked).toBe(root);
    expect(JSON.parse(readFileSync(lastFile, "utf8"))).toEqual({ dir: root });

    writeFileSync(lastFile, "not json");
    expect(
      await resolveProjectDir({ env: undefined, lastFile, pick: () => Promise.resolve("/y") }),
    ).toBe("/y");
  });

  it("returns undefined when the user cancels", async () => {
    const lastFile = join(scratch(), "last-project.json");
    expect(
      await resolveProjectDir({ env: undefined, lastFile, pick: () => Promise.resolve(undefined) }),
    ).toBeUndefined();
  });
});
