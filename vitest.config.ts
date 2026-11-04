import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "kernel", include: ["packages/kernel/test/**/*.test.ts"] } },
      {
        resolve: {
          alias: {
            "@loom/kernel": fileURLToPath(new URL("packages/kernel/src/index.ts", import.meta.url)),
          },
        },
        test: { name: "sdk", include: ["packages/sdk/test/**/*.test.ts"] },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      reporter: ["text", "lcov"],
      thresholds: { statements: 95, branches: 95, functions: 95, lines: 95 },
    },
  },
});
