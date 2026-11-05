import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import {
  boundariesConfig,
  exportRules,
  platformNeutralConfigs,
  workspaceConfigs,
} from "./eslint.rules.js";

export default defineConfig(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/.turbo/**",
      "node_modules/**",
      "tools/lint-fixtures/**",
      "plugins/*/test/fixtures/**",
      "apps/*/out/**",
      "apps/*/e2e/*.mjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "max-lines": ["error", { max: 300, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["error", { max: 80, skipBlankLines: true, skipComments: true }],
      "@typescript-eslint/no-explicit-any": "error",
      ...exportRules,
    },
  },
  {
    files: ["*.config.{js,ts,cjs}", "apps/*/*.config.ts"],
    rules: { "no-restricted-exports": "off" },
  },
  {
    // plugin entries default-export their definePlugin(...)
    files: ["plugins/*/src/{main,renderer}.{ts,tsx}"],
    rules: { "no-restricted-exports": "off" },
  },
  {
    files: ["**/*.cjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: { module: "writable" } },
  },
  boundariesConfig,
  ...workspaceConfigs,
  ...platformNeutralConfigs,
);
