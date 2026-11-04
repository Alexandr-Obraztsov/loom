import { builtinModules } from "node:module";
import boundaries from "eslint-plugin-boundaries";

const BARE_BUILTINS = builtinModules.filter((m) => !m.startsWith("_"));
const BUILTIN_PATHS = [
  ...new Set([...BARE_BUILTINS, ...BARE_BUILTINS.map((m) => `node:${m}`)]),
].map((name) => ({
  name,
  message: "Node built-ins are not allowed here; keep this layer platform-neutral.",
}));
const BUILTIN_PATTERNS = [
  {
    group: ["node:*"],
    message: "Node built-ins are not allowed here; keep this layer platform-neutral.",
  },
];

/** Rules shared by the real lint run and the lint-fixtures regression check. */
export const exportRules = {
  "no-restricted-exports": [
    "error",
    {
      restrictDefaultExports: {
        direct: true,
        named: true,
        defaultFrom: true,
        namedFrom: true,
        namespaceFrom: true,
      },
    },
  ],
};

const KERNEL_ELEMENTS = ["kernel-core", "kernel-rpc", "kernel-node", "kernel-other"];
const ENTRY = { to: { file: { categories: "kernel-entry" } } };
const allowTo = (...types) => ({ to: { element: { types } } });

export const boundariesConfig = {
  files: ["packages/**/*.ts"],
  plugins: { boundaries },
  settings: {
    "import/resolver": {
      typescript: { project: ["packages/*/tsconfig.json"], noWarnOnMultipleProjects: true },
    },
    "boundaries/files": [{ pattern: "packages/kernel/src/index.ts", category: "kernel-entry" }],
    "boundaries/elements": [
      { type: "kernel-core", pattern: "packages/kernel/src/core/**", partialMatch: false },
      { type: "kernel-rpc", pattern: "packages/kernel/src/rpc/**", partialMatch: false },
      { type: "kernel-node", pattern: "packages/kernel/src/node/**", partialMatch: false },
      { type: "kernel-other", pattern: "packages/kernel/src/**", partialMatch: false },
      { type: "sdk", pattern: "packages/sdk/src/**", partialMatch: false },
      { type: "kernel-test", pattern: "packages/kernel/test/**", partialMatch: false },
      { type: "kernel-bench", pattern: "packages/kernel/bench/**", partialMatch: false },
      { type: "sdk-test", pattern: "packages/sdk/test/**", partialMatch: false },
    ],
  },
  rules: {
    "boundaries/dependencies": [
      "error",
      {
        default: "disallow",
        policies: [
          { from: { element: { type: "kernel-core" } }, allow: allowTo("kernel-core") },
          {
            from: { element: { type: "kernel-rpc" } },
            allow: allowTo("kernel-core", "kernel-rpc"),
          },
          {
            from: { element: { type: "kernel-node" } },
            allow: allowTo("kernel-core", "kernel-node"),
          },
          { from: { element: { type: "kernel-other" } }, allow: allowTo(...KERNEL_ELEMENTS) },
          { from: { element: { type: "sdk" } }, allow: [allowTo("sdk"), ENTRY] },
          {
            from: { element: { type: "kernel-test" } },
            allow: allowTo(...KERNEL_ELEMENTS, "kernel-test"),
          },
          {
            from: { element: { type: "kernel-bench" } },
            allow: allowTo(...KERNEL_ELEMENTS, "kernel-test"),
          },
          {
            from: { element: { type: "sdk-test" } },
            allow: [allowTo("sdk", "sdk-test"), ENTRY],
          },
        ],
      },
    ],
  },
};

export const platformNeutralConfigs = [
  {
    files: ["packages/kernel/src/rpc/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { paths: BUILTIN_PATHS, patterns: BUILTIN_PATTERNS }],
    },
  },
  {
    files: ["packages/kernel/src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            ...BUILTIN_PATHS,
            { name: "electron", message: "Core must not depend on electron." },
            { name: "react", message: "Core must not depend on react." },
            { name: "@loom/sdk", message: "Kernel must not depend on the SDK." },
          ],
          patterns: [
            ...BUILTIN_PATTERNS,
            {
              group: ["electron/*", "react/*", "react-dom", "react-dom/*"],
              message: "Core must not depend on UI or shell libraries.",
            },
          ],
        },
      ],
    },
  },
];
