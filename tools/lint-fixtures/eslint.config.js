import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import { boundariesConfig, exportRules, platformNeutralConfigs } from "../../eslint.rules.js";

export default defineConfig(
  { files: ["packages/**/*.ts"], languageOptions: { parser: tseslint.parser } },
  { files: ["packages/**/*.ts"], rules: exportRules },
  boundariesConfig,
  ...platformNeutralConfigs,
);
