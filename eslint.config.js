import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import boundaries from "eslint-plugin-boundaries";
import tseslint from "typescript-eslint";

const nodeBuiltinsBan = [
  {
    group: ["node:*"],
    message: "Node built-ins are not allowed here; keep this layer platform-neutral.",
  },
];

export default defineConfig(
  { ignores: ["**/dist/**", "**/coverage/**", "**/.turbo/**", "node_modules/**"] },
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
      "no-restricted-exports": ["error", { restrictDefaultExports: { direct: true } }],
    },
  },
  {
    files: ["*.config.{js,ts,cjs}"],
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
  {
    files: ["packages/**/*.ts"],
    plugins: { boundaries },
    settings: {
      "boundaries/elements": [
        { type: "kernel-core", pattern: "packages/kernel/src/core/**", partialMatch: false },
        { type: "kernel-rpc", pattern: "packages/kernel/src/rpc/**", partialMatch: false },
        { type: "kernel-node", pattern: "packages/kernel/src/node/**", partialMatch: false },
        { type: "sdk", pattern: "packages/sdk/src/**", partialMatch: false },
      ],
    },
    rules: {
      "boundaries/dependencies": [
        "error",
        {
          default: "allow",
          policies: [
            {
              from: { element: { type: "kernel-core" } },
              disallow: {
                to: { element: { types: ["kernel-rpc", "kernel-node", "sdk"] } },
              },
            },
            {
              from: { element: { type: "kernel-rpc" } },
              disallow: { to: { element: { types: ["kernel-node", "sdk"] } } },
            },
            {
              from: { element: { type: "kernel-node" } },
              disallow: { to: { element: { types: ["kernel-rpc", "sdk"] } } },
            },
            {
              from: { element: { type: "sdk" } },
              disallow: {
                to: { element: { types: ["kernel-core", "kernel-rpc", "kernel-node"] } },
              },
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/kernel/src/core/**/*.ts", "packages/kernel/src/rpc/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: nodeBuiltinsBan }],
    },
  },
  {
    files: ["packages/kernel/src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...nodeBuiltinsBan,
            {
              group: ["**/src/index.js", "../index.js", "../../index.js"],
              message: "Core must not import the package entry.",
            },
          ],
          paths: [
            { name: "electron", message: "Core must not depend on electron." },
            { name: "react", message: "Core must not depend on react." },
            { name: "@loom/sdk", message: "Kernel must not depend on the SDK." },
          ],
        },
      ],
    },
  },
);
