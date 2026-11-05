import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import {
  boundariesConfig,
  exportRules,
  platformNeutralConfigs,
  readabilityConfig,
  workspaceConfigs,
} from "../../eslint.rules.js";

export default defineConfig(
  {
    files: ["packages/**/*.{ts,tsx}", "plugins/**/*.{ts,tsx}", "apps/**/*.{ts,tsx}"],
    languageOptions: { parser: tseslint.parser },
  },
  {
    files: ["packages/**/*.{ts,tsx}", "plugins/**/*.{ts,tsx}", "apps/**/*.{ts,tsx}"],
    rules: exportRules,
  },
  boundariesConfig,
  {
    // readability rules, with the type information two of them need
    ...readabilityConfig,
    plugins: { ...readabilityConfig.plugins, "@typescript-eslint": tseslint.plugin },
    files: ["readability/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  ...workspaceConfigs,
  ...platformNeutralConfigs,
);
