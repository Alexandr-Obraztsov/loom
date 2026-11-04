import { bench, describe } from "vitest";
import { buildTree } from "../src/core/tree.js";
import type { ExtensionContext } from "../src/core/types.js";
import { treeFixture } from "../test/perf-fixtures.js";

const use = ((): never => {
  throw new Error("unused");
}) as ExtensionContext<never>["use"];
const tree = treeFixture(2000);
const first = buildTree(tree.entries, {}, use);
const changed = tree.withLeafChanged();

describe("tree", () => {
  bench("buildTree 2000 extensions cold", () => {
    buildTree(tree.entries, {}, use);
  });
  bench("rebuild after 1 leaf change", () => {
    buildTree(changed, {}, use, first);
  });
});
