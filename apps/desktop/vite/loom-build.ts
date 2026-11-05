import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";

type Side = "main" | "renderer";

interface PackageJson {
  readonly loom?: {
    readonly plugins?: readonly string[];
    readonly main?: string;
    readonly renderer?: string;
  };
}

const PREFIX = "\0";
const MODULES: Readonly<Record<string, Side>> = {
  "virtual:loom/main-plugins": "main",
  "virtual:loom/renderer-plugins": "renderer",
};

const readJson = (path: string): PackageJson =>
  JSON.parse(readFileSync(path, "utf8")) as PackageJson;

/**
 * Entry source files of `side` for every plugin of the build at `buildDir`, in the build's order.
 * Plugins without that entry are skipped. The `loom.main`/`loom.renderer` field is a source path:
 * the shell bundles plugin sources in dev and in production alike.
 */
export function pluginEntries(buildDir: string, side: Side): string[] {
  const names = readJson(join(buildDir, "package.json")).loom?.plugins ?? [];
  const entries: string[] = [];
  for (const name of names) {
    const dir = realpathSync(join(buildDir, "node_modules", name));
    const entry = readJson(join(dir, "package.json")).loom?.[side];
    if (entry !== undefined) entries.push(resolve(dir, entry));
  }
  return entries;
}

/** Vite plugin serving `virtual:loom/main-plugins` and `virtual:loom/renderer-plugins`. */
export function loomBuild(options: { readonly buildDir: string }): Plugin {
  return {
    name: "loom-build",
    resolveId(id) {
      return Object.hasOwn(MODULES, id) ? PREFIX + id : undefined;
    },
    load(id) {
      const name = id.slice(PREFIX.length);
      if (!id.startsWith(PREFIX) || !Object.hasOwn(MODULES, name)) return undefined;
      const side = MODULES[name] as Side;
      const entries = pluginEntries(options.buildDir, side);
      const imports = entries.map(
        (file, i) => `import p${String(i)} from ${JSON.stringify(file)};`,
      );
      const list = entries.map((_, i) => `p${String(i)}`).join(", ");
      return `${imports.join("\n")}\nexport const plugins = [${list}];\n`;
    },
  };
}
