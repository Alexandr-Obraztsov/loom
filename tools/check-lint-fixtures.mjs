// Regression check: every architectural lint rule must keep firing on its fixture.
import { ESLint } from "eslint";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "lint-fixtures");
const k = "packages/kernel/src";
const s = "packages/sdk/src";
const BOUNDARIES = "boundaries/dependencies";
const IMPORTS = "no-restricted-imports";
const EXPORTS = "no-restricted-exports";

/** @type {Record<string, string | null>} fixture file -> the single expected rule (null = clean) */
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
  [`${s}/ok.ts`]: null,
  [`${s}/internal.ts`]: BOUNDARIES,
  [`${s}/default-direct.ts`]: EXPORTS,
  [`${s}/default-named.ts`]: EXPORTS,
  [`${s}/default-from.ts`]: EXPORTS,
  [`${s}/default-named-from.ts`]: EXPORTS,
  [`${s}/default-namespace-from.ts`]: EXPORTS,
};

// eslint-plugin-boundaries resolves element patterns against process.cwd().
process.chdir(root);
const eslint = new ESLint({ cwd: root });
const results = await eslint.lintFiles(["packages"]);
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
  const got = [...new Set(result.messages.map((m) => m.ruleId ?? `parse: ${m.message}`))];
  const wantList = want === null ? [] : [want];
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
