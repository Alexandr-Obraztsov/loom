import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import type { UserConfig } from "electron-vite";
import { defineConfig } from "electron-vite";

import { loomBuild } from "./vite/loom-build.js";

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const buildDir = here("../../builds/minimal");

// workspace packages export built output (or are TS sources): bundle them from source
const alias = {
  "@loom/kernel": here("../../packages/kernel/src/index.ts"),
  "@loom/sdk": here("../../packages/sdk/src/index.ts"),
  "@loom/react": here("../../packages/react/src/index.ts"),
};
const bundled = ["@loom/kernel", "@loom/sdk", "@loom/react", "@loom/plugin-acp"];

const config: UserConfig = defineConfig({
  main: {
    resolve: { alias },
    plugins: [loomBuild({ buildDir })],
    build: { externalizeDeps: { exclude: bundled } },
  },
  preload: {
    build: {
      // a sandboxed preload must be CommonJS
      rolldownOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: {
    root: here("src/renderer"),
    resolve: { alias },
    plugins: [react(), loomBuild({ buildDir })],
    build: { rolldownOptions: { input: here("src/renderer/index.html") } },
  },
});

export default config;
