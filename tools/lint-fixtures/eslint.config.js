import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import {
  boundariesConfig,
  exportRules,
  platformNeutralConfigs,
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
  ...workspaceConfigs,
  ...platformNeutralConfigs,
);
