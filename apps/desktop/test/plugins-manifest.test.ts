import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePlugin } from "@loom/kernel";
import { describe, expect, it } from "vitest";
import { createTurnGuard } from "../src/main/turn-guard.js";
import { pluginEntries } from "../vite/loom-build.js";

const buildDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../builds/minimal");

/** The plugin definitions a build ships: the default export of each entry, as the shell's virtual module lists them. */
async function definitionsOf(side: "main" | "renderer"): Promise<{ entry: string; def: unknown }[]> {
  return Promise.all(
    pluginEntries(buildDir, side).map(async (entry) => ({
      entry,
      def: ((await import(/* @vite-ignore */ entry)) as { default: unknown }).default,
    })),
  );
}

describe("repository plugins against the strict manifest schema", () => {
  it.each(["main", "renderer"] as const)("every %s entry of builds/minimal passes validatePlugin", async (side) => {
    const found = await definitionsOf(side);
    expect(found.length).toBeGreaterThan(0);
    for (const { entry, def } of found) {
      expect(() => validatePlugin(def), entry).not.toThrow();
    }
  });

  it("the desktop turn guard passes validatePlugin", () => {
    expect(() => validatePlugin(createTurnGuard().plugin)).not.toThrow();
  });
});
