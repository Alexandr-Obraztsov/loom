import { bench, describe } from "vitest";

import { createHookRegistry } from "../src/core/hooks.js";
import { pluginHook } from "../test/perf-fixtures.js";

const reg = createHookRegistry({ onError: () => undefined });
for (let t = 0; t < 20; t++) reg.tap(pluginHook, { owner: `o${String(t)}`, priority: t % 3 }, (c, next) => next(c + 1));
const fallback = (c: number): Promise<number> => Promise.resolve(c);

describe("hooks", () => {
  bench("hook run, 20 taps, async", async () => {
    await reg.run(pluginHook, 0, fallback);
  });
});
