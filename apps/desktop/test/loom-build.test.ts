import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loomBuild, pluginEntries } from "../vite/loom-build.js";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "loom-build-"));
  const write = (dir: string, json: object): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(json));
  };
  const build = join(root, "build");
  write(build, {
    loom: { build: true, plugins: ["@x/both", "@x/main-only", "@x/renderer-only", "@x/none"] },
  });
  const plugins: Record<string, object> = {
    both: { loom: { id: "both", main: "./src/main.ts", renderer: "./src/renderer.tsx" } },
    "main-only": { loom: { id: "main-only", main: "./src/main.ts" } },
    "renderer-only": { loom: { id: "renderer-only", renderer: "./src/renderer.tsx" } },
    none: {},
  };
  mkdirSync(join(build, "node_modules/@x"), { recursive: true });
  for (const [name, json] of Object.entries(plugins)) {
    write(join(root, "pkgs", name), json);
    symlinkSync(join(root, "pkgs", name), join(build, "node_modules/@x", name));
  }
  return build;
}

describe("pluginEntries", () => {
  it("lists the entries of the side in build order and skips plugins without one", () => {
    const build = fixture();
    const names = (side: "main" | "renderer"): string[] =>
      pluginEntries(build, side).map((p) => p.split("/").slice(-3).join("/"));
    expect(names("main")).toEqual(["both/src/main.ts", "main-only/src/main.ts"]);
    expect(names("renderer")).toEqual(["both/src/renderer.tsx", "renderer-only/src/renderer.tsx"]);
  });
});

describe("loomBuild", () => {
  it("serves both virtual modules and ignores other ids", () => {
    const plugin = loomBuild({ buildDir: fixture() });
    const resolveId = plugin.resolveId as (id: string) => string | undefined;
    const load = plugin.load as (id: string) => string | undefined;
    expect(resolveId("other")).toBeUndefined();
    const main = load(resolveId("virtual:loom/main-plugins") as string) as string;
    expect(main).toContain("export const plugins = [p0, p1];");
    expect(main).toContain("both/src/main.ts");
    const renderer = load(resolveId("virtual:loom/renderer-plugins") as string) as string;
    expect(renderer).toContain("renderer-only/src/renderer.tsx");
    expect(load("\0other")).toBeUndefined();
    expect(load("virtual:loom/main-plugins")).toBeUndefined();
  });
});

describe("loomBuild prototype keys", () => {
  it("does not treat inherited object keys as virtual modules", () => {
    const plugin = loomBuild({ buildDir: fixture() });
    const resolveId = plugin.resolveId as (id: string) => string | undefined;
    const load = plugin.load as (id: string) => string | undefined;
    expect(resolveId("toString")).toBeUndefined();
    expect(load("\0toString")).toBeUndefined();
  });
});
