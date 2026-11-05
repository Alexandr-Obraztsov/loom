import { describe, expect, it } from "vitest";

import { buildTree } from "../../src/core/tree.js";
import type { Entry } from "./tree-helpers.js";
import { at, e, ext, use } from "./tree-helpers.js";

const slot = { slot: { multiple: true } };
const chain = (): Entry[] => [
  e("p", ext("a", { attachTo: at("ghost", "slot"), inputs: slot })),
  e("q", ext("b", { attachTo: at("a", "slot"), inputs: slot })),
  e("p", ext("c", { attachTo: at("b", "slot"), inputs: slot })),
  e("r", ext("d", { attachTo: at("b", "slot") })),
];

describe("orphan reasons along a detached chain", () => {
  it("are the same whichever end the walk starts from", () => {
    const forward = buildTree(chain(), {}, { use }).orphans;
    const backward = buildTree(chain().reverse(), {}, { use }).orphans;
    const view = (o: typeof forward): unknown[] => o.map((x) => [x.id, x.reason.message, x.reason.pluginIds]);
    expect(view(backward)).toEqual(view(forward));
    expect(view(forward)).toEqual([
      ["a", 'Extension "a" is attached to missing parent "ghost"', ["p"]],
      ["b", 'Extension "b" is unreachable: ancestor "a" is attached to missing parent "ghost"', ["q", "p"]],
      ["c", 'Extension "c" is unreachable: ancestor "a" is attached to missing parent "ghost"', ["p", "q"]],
      ["d", 'Extension "d" is unreachable: ancestor "a" is attached to missing parent "ghost"', ["r", "q", "p"]],
    ]);
  });
});
