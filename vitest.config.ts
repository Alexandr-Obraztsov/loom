import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const PERF = "packages/kernel/test/perf.test.ts";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "kernel",
          include: ["packages/kernel/test/**/*.test.ts"],
          exclude: [PERF],
          benchmark: { include: ["packages/kernel/bench/**/*.bench.ts"] },
        },
      },
      // timing guards: run alone (`pnpm test:perf`), never under coverage instrumentation
      { test: { name: "perf", include: [PERF] } },
      {
        resolve: {
          alias: {
            "@loom/kernel": fileURLToPath(new URL("packages/kernel/src/index.ts", import.meta.url)),
          },
        },
        test: { name: "sdk", include: ["packages/sdk/test/**/*.test.ts"], benchmark: { include: [] } },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      reporter: ["text", "lcov"],
      thresholds: {
        "packages/kernel/src/**": { statements: 95, branches: 95, functions: 95, lines: 95 },
        "packages/sdk/src/**": { statements: 95, branches: 95, functions: 95, lines: 95 },
      },
    },
  },
});
