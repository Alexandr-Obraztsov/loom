import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const PERF = "packages/kernel/test/perf.test.ts";
const src = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const alias = {
  "@loom/kernel": src("packages/kernel/src/index.ts"),
  "@loom/sdk": src("packages/sdk/src/index.ts"),
  "@loom/host": src("packages/host/src/index.ts"),
  "@loom/react": src("packages/react/src/index.ts"),
};
const threshold = { statements: 95, branches: 95, functions: 95, lines: 95 };

export default defineConfig({
  test: {
    // a fresh checkout has no plugin tests yet
    passWithNoTests: true,
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
        resolve: { alias },
        test: {
          name: "sdk",
          include: ["packages/sdk/test/**/*.test.ts"],
          benchmark: { include: [] },
        },
      },
      {
        resolve: { alias },
        test: {
          name: "host",
          include: ["packages/host/test/**/*.test.ts"],
          benchmark: { include: [] },
        },
      },
      {
        resolve: { alias },
        test: {
          name: "react",
          environment: "happy-dom",
          include: ["packages/react/test/**/*.test.{ts,tsx}"],
          benchmark: { include: [] },
        },
      },
      // plugins: `*.test.ts` run in node (main side), `*.test.tsx` in happy-dom (renderer side)
      {
        resolve: { alias },
        test: {
          name: "plugins-main",
          include: ["plugins/*/test/**/*.test.ts"],
          benchmark: { include: [] },
        },
      },
      {
        resolve: { alias },
        test: {
          name: "plugins-renderer",
          environment: "happy-dom",
          include: ["plugins/*/test/**/*.test.tsx"],
          benchmark: { include: [] },
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.{ts,tsx}", "plugins/*/src/**/*.{ts,tsx}"],
      reporter: ["text", "lcov"],
      thresholds: {
        "packages/kernel/src/**": threshold,
        "packages/sdk/src/**": threshold,
        "packages/host/src/**": threshold,
        "packages/react/src/**": threshold,
        // aggregated over all plugins (vitest thresholds are per glob, not per matched directory)
        "plugins/*/src/**": threshold,
        "plugins/claude-code/src/**": threshold,
        "plugins/storage/src/**": threshold,
        "plugins/acp/src/**": threshold,
        "plugins/app/src/**": threshold,
        "plugins/layout-bare/src/**": threshold,
        "plugins/chat/src/**": threshold,
      },
    },
  },
});
