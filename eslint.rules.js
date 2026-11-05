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
const PACKAGE_ENTRY = { to: { file: { categories: "package-entry" } } };
const PLUGIN_ENTRY = { to: { file: { categories: "plugin-entry" } } };
const OWN_PLUGIN = {
  to: { element: { type: "plugin", captured: { plugin: "{{from.captured.plugin}}" } } },
};

const SOURCE_FILES = ["packages/**/*.{ts,tsx}", "plugins/**/*.{ts,tsx}", "apps/**/*.{ts,tsx}"];

export const boundariesConfig = {
  files: SOURCE_FILES,
  plugins: { boundaries },
  settings: {
    "import/resolver": {
      typescript: {
        project: ["packages/*/tsconfig.json", "plugins/*/tsconfig.json", "apps/*/tsconfig.json"],
        noWarnOnMultipleProjects: true,
      },
    },
    "boundaries/files": [
      { pattern: "packages/kernel/src/index.ts", category: "kernel-entry" },
      { pattern: "packages/{sdk,react}/src/index.ts", category: "package-entry" },
      { pattern: "plugins/*/src/{api,index}.ts", category: "plugin-entry" },
    ],
    "boundaries/elements": [
      { type: "kernel-core", pattern: "packages/kernel/src/core/**", partialMatch: false },
      { type: "kernel-rpc", pattern: "packages/kernel/src/rpc/**", partialMatch: false },
      { type: "kernel-node", pattern: "packages/kernel/src/node/**", partialMatch: false },
      { type: "kernel-other", pattern: "packages/kernel/src/**", partialMatch: false },
      { type: "sdk", pattern: "packages/sdk/src/**", partialMatch: false },
      { type: "kernel-test", pattern: "packages/kernel/test/**", partialMatch: false },
      { type: "kernel-bench", pattern: "packages/kernel/bench/**", partialMatch: false },
      { type: "sdk-test", pattern: "packages/sdk/test/**", partialMatch: false },
      { type: "react-pkg", pattern: "packages/react/src/**", partialMatch: false },
      { type: "react-test", pattern: "packages/react/test/**", partialMatch: false },
      { type: "plugin", pattern: "plugins/*/src/**", partialMatch: false, capture: ["plugin"] },
      {
        type: "plugin-test",
        pattern: "plugins/*/test/**",
        partialMatch: false,
        capture: ["plugin"],
      },
      { type: "app", pattern: "apps/*/src/**", partialMatch: false },
      { type: "app-test", pattern: "apps/*/test/**", partialMatch: false },
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
          { from: { element: { type: "react-pkg" } }, allow: [allowTo("react-pkg"), ENTRY] },
          {
            from: { element: { type: "react-test" } },
            allow: [allowTo("react-pkg", "react-test"), ENTRY],
          },
          // a plugin sees its own files and the public entries of packages and other plugins
          {
            from: { element: { type: "plugin" } },
            allow: [OWN_PLUGIN, PACKAGE_ENTRY, PLUGIN_ENTRY],
          },
          {
            from: { element: { type: "plugin-test" } },
            allow: [OWN_PLUGIN, allowTo("plugin-test"), ENTRY, PACKAGE_ENTRY, PLUGIN_ENTRY],
          },
          // an app may use anything except the internals of kernel
          {
            from: { element: { type: "app-test" } },
            allow: [allowTo("app", "app-test"), ENTRY, PACKAGE_ENTRY, PLUGIN_ENTRY],
          },
          {
            from: { element: { type: "app" } },
            allow: [allowTo("app"), ENTRY, PACKAGE_ENTRY, PLUGIN_ENTRY],
          },
        ],
      },
    ],
  },
};

const PLUGIN_AND_APP_NAMES = ["@loom/plugin-*", "@loom/desktop"];
const NO_UPWARD_IMPORTS = {
  group: PLUGIN_AND_APP_NAMES,
  message: "Packages must not import plugins or apps.",
};
const SDK_MESSAGE = "Kernel must not depend on the SDK.";
const SDK_PATH = { name: "@loom/sdk", message: SDK_MESSAGE };
const SDK_SUBPATHS = { group: ["@loom/sdk/*"], message: SDK_MESSAGE };
const PLATFORM_GLOBALS = ["process", "Buffer"].map((name) => ({
  name,
  message: "Node globals are not allowed here; keep this layer platform-neutral.",
}));

export const platformNeutralConfigs = [
  {
    files: ["packages/kernel/src/rpc/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [...BUILTIN_PATHS, SDK_PATH],
          patterns: [...BUILTIN_PATTERNS, NO_UPWARD_IMPORTS, SDK_SUBPATHS],
        },
      ],
      "no-restricted-globals": ["error", ...PLATFORM_GLOBALS],
    },
  },
  {
    // Node built-ins are fine here; the SDK is a facade over the kernel, never the other way round
    files: ["packages/kernel/src/node/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: [SDK_PATH], patterns: [NO_UPWARD_IMPORTS, SDK_SUBPATHS] },
      ],
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
            SDK_PATH,
          ],
          patterns: [
            ...BUILTIN_PATTERNS,
            NO_UPWARD_IMPORTS,
            SDK_SUBPATHS,
            {
              group: ["electron/*", "react/*", "react-dom", "react-dom/*"],
              message: "Core must not depend on UI or shell libraries.",
            },
          ],
        },
      ],
      "no-restricted-globals": ["error", ...PLATFORM_GLOBALS],
    },
  },
];

const PLUGIN_SOURCE = ["plugins/*/src/**/*.{ts,tsx}"];
const PLUGIN_MAIN = ["plugins/*/src/main*.{ts,tsx}", "plugins/*/src/main/**/*.{ts,tsx}"];

const KERNEL_PATH = {
  name: "@loom/kernel",
  message: "Plugins import @loom/sdk, not @loom/kernel.",
};
const PLUGIN_PATTERNS = [
  { group: ["@loom/kernel/*"], message: "Plugins import @loom/sdk, not @loom/kernel." },
  { group: ["@loom/*/src/*"], message: "Import a package by its public entry." },
];

export const workspaceConfigs = [
  {
    // packages are the platform: they never reach up into plugins, builds or apps
    files: ["packages/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [NO_UPWARD_IMPORTS],
        },
      ],
    },
  },
  {
    // plugins go through the facade, never the kernel itself; Node built-ins only on the main side
    files: PLUGIN_SOURCE,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [...BUILTIN_PATHS, KERNEL_PATH],
          patterns: [...BUILTIN_PATTERNS, ...PLUGIN_PATTERNS],
        },
      ],
    },
  },
  {
    files: PLUGIN_MAIN,
    rules: {
      "no-restricted-imports": ["error", { paths: [KERNEL_PATH], patterns: PLUGIN_PATTERNS }],
    },
  },
];
