// Regression check: every architectural lint rule must keep firing on its fixture.
import { ESLint } from "eslint";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "lint-fixtures");
const k = "packages/kernel/src";
const kt = "packages/kernel/test";
const st = "packages/sdk/test";
const rt = "packages/react/test";
const s = "packages/sdk/src";
const r = "packages/react/src";
const p = "plugins";
const a = "apps/desk/src";
const BOUNDARIES = "boundaries/dependencies";
const IMPORTS = "no-restricted-imports";
const EXPORTS = "no-restricted-exports";
const GLOBALS = "no-restricted-globals";

/** @type {Record<string, string | string[] | null>} fixture file -> the expected rule(s), sorted alphabetically when several (null = clean) */
const expected = {
  [`${k}/index.ts`]: null,
  [`${k}/util.ts`]: null,
  [`${k}/core/base.ts`]: null,
  [`${k}/core/ok.ts`]: null,
  [`${k}/core/bare-builtin.ts`]: IMPORTS,
  [`${k}/rpc/node-builtin.ts`]: IMPORTS,
  [`${k}/core/deep/x/deep-entry.ts`]: BOUNDARIES,
  [`${k}/core/unclassified.ts`]: BOUNDARIES,
  [`${k}/rpc/entry.ts`]: BOUNDARIES,
  // the node layer sees core and itself, never rpc or the package entry
  [`${k}/node/ok.ts`]: null,
  [`${k}/node/to-rpc.ts`]: BOUNDARIES,
  [`${k}/node/to-entry.ts`]: BOUNDARIES,
  // no layer of the kernel depends on the SDK
  [`${k}/core/imports-sdk.ts`]: IMPORTS,
  [`${k}/core/imports-sdk-subpath.ts`]: IMPORTS,
  [`${k}/rpc/imports-sdk-subpath.ts`]: IMPORTS,
  [`${k}/node/imports-sdk-subpath.ts`]: IMPORTS,
  [`${k}/rpc/imports-sdk.ts`]: IMPORTS,
  [`${k}/node/imports-sdk.ts`]: IMPORTS,
  // core and rpc stay platform-neutral: no Node globals either
  [`${k}/core/process-global.ts`]: GLOBALS,
  [`${k}/core/buffer-global.ts`]: GLOBALS,
  [`${k}/rpc/process-global.ts`]: GLOBALS,
  [`${k}/rpc/buffer-global.ts`]: GLOBALS,
  // tests see their own package's source (and the kernel's public entry from sdk), nothing else
  [`${kt}/ok.test.ts`]: null,
  [`${kt}/sdk-internal.test.ts`]: BOUNDARIES,
  [`${st}/ok.test.ts`]: null,
  [`${st}/kernel-internal.test.ts`]: BOUNDARIES,
  [`${rt}/ok.test.ts`]: null,
  [`${rt}/sdk-internal.test.ts`]: BOUNDARIES,
  [`${s}/ok.ts`]: null,
  [`${s}/kernel-core.ts`]: BOUNDARIES,
  [`${s}/internal.ts`]: BOUNDARIES,
  [`${s}/default-direct.ts`]: EXPORTS,
  [`${s}/default-named.ts`]: EXPORTS,
  [`${s}/default-from.ts`]: EXPORTS,
  [`${s}/default-named-from.ts`]: EXPORTS,
  [`${s}/default-namespace-from.ts`]: EXPORTS,
  [`${s}/index.ts`]: null,
  [`${r}/index.ts`]: null,
  // packages never import plugins (by path or by package name)
  [`${r}/imports-plugin.ts`]: BOUNDARIES,
  [`${r}/imports-plugin-name.ts`]: IMPORTS,
  [`${p}/foo/src/api.ts`]: null,
  [`${p}/foo/src/internal.ts`]: null,
  // renderer plugin files must not import Node built-ins; main may
  [`${p}/foo/src/renderer.ts`]: IMPORTS,
  [`${p}/foo/src/main.ts`]: null,
  [`${p}/bar/src/renderer.ts`]: null,
  [`${p}/bar/src/deep.ts`]: BOUNDARIES,
  // plugin tests may use the kernel entry, plugin sources may not
  [`${p}/foo/test/kernel.test.ts`]: null,
  [`${p}/bar/src/kernel.ts`]: [BOUNDARIES, IMPORTS],
  [`${a}/main.ts`]: null,
  [`${a}/deep.ts`]: BOUNDARIES,
  // app tests may use public entries, not kernel internals
  ["apps/desk/test/ok.test.ts"]: null,
  ["apps/desk/test/kernel-internal.test.ts"]: BOUNDARIES,
};

// eslint-plugin-boundaries resolves element patterns against process.cwd().
process.chdir(root);
const eslint = new ESLint({ cwd: root });
const results = await eslint.lintFiles(["packages", "plugins", "apps"]);
const failures = [];
const seen = new Set();
for (const result of results) {
  const rel = path.relative(root, result.filePath);
  seen.add(rel);
  const want = expected[rel];
  if (want === undefined) {
    failures.push(`${rel}: fixture has no expectation`);
    continue;
  }
  const got = [...new Set(result.messages.map((m) => m.ruleId ?? `parse: ${m.message}`))].sort();
  const wantList = want === null ? [] : [want].flat().sort();
  if (got.join() !== wantList.join()) {
    failures.push(`${rel}: expected [${wantList.join()}], got [${got.join()}]`);
  }
}
for (const rel of Object.keys(expected)) {
  if (!seen.has(rel)) failures.push(`${rel}: expected fixture was not linted`);
}

if (failures.length > 0) {
  process.stderr.write(`Lint fixtures check failed:\n${failures.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`Lint fixtures check passed (${String(seen.size)} fixtures).\n`);
