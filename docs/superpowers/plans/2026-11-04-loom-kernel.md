# Loom Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@loom/kernel` and `@loom/sdk` — a platform-agnostic plugin kernel (loader, services, hooks, events, extension tree, live `reconcile()`, cross-process RPC) with full test coverage, benchmarks and CI in a new GitHub repository.

**Architecture:** The kernel is a pure TypeScript library with no Node or DOM dependencies in its core (`src/core`); a Node-only package loader lives behind the `@loom/kernel/node` subpath. Plugins are plain definition objects; the kernel resolves their dependency graph, runs `setup` with a scoped context that tracks every registration for automatic disposal, and rebuilds an immutable extension tree with structural sharing. `@loom/sdk` is a thin facade re-exporting the public subset; plugins import only the SDK.

**Tech Stack:** TypeScript 5.9 (strict, ESM only), Node 22+, pnpm workspaces + Turborepo, Vitest 4 (+ `@vitest/coverage-v8`, `vitest bench`), fast-check (property tests), zod 4, semver 7, ESLint flat config + typescript-eslint `strictTypeChecked` + eslint-plugin-boundaries, Prettier, dependency-cruiser, knip, api-extractor, Changesets, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-04-loom-design.md` — sections 4.1–4.5, 9, 10a, 11a.

## Global Constraints

- Core (`packages/kernel/src/core/**`) must not import Node built-ins, DOM globals, `electron` or `react`. Only `zod` and `semver` as runtime deps.
- `@loom/sdk` imports only `@loom/kernel`; nothing in `packages/kernel` imports `@loom/sdk`.
- TypeScript: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedDeclarations`; ESM only.
- ESLint: `max-lines: 300` per file, `max-lines-per-function: 80`; no `any`; no default exports except plugin entry files.
- Coverage thresholds enforced in CI: statements, branches, functions, lines ≥ 95% for `packages/kernel` and `packages/sdk`.
- No silent behavior: every conflict, missing dependency or failed plugin produces a `LoomError` with a stable `code` and the plugin id(s) involved.
- Every registration made through a plugin context is removed when that plugin is disposed.
- `reconcile()` calls are serialized; a failed reconcile leaves the kernel exactly in its previous state.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Plugin throws in `setup` mid-reconcile after others already started** — kernel must roll back every plugin set up in this pass and restore the previous versions with their `ctx.state`. Test owned by Task 10.
2. **A service consumer keeps a reference across an `override` or a provider reload** — calls must reach the current provider; calling after the provider is removed throws `SERVICE_MISSING`, not a stale call. Test owned by Task 5.
3. **Hook tap that never calls `next` and never returns (hangs) over RPC** — remote tap times out, run continues with `next(ctx)`, and a `kernel.error` event names the plugin. Test owned by Task 11.
4. **Two `reconcile()` calls issued concurrently (install while a reload runs)** — second waits for the first; final state equals applying both in order. Test owned by Task 10.
5. **Extension factory throws or returns a value failing the input schema** — only that node carries `error`; siblings and the rest of the tree render; the error names extension and plugin. Test owned by Task 8.

---

## File Structure

```
.github/workflows/ci.yml
package.json  pnpm-workspace.yaml  turbo.json  tsconfig.base.json
eslint.config.js  .prettierrc  .dependency-cruiser.cjs  knip.json  vitest.workspace.ts
packages/kernel/
  package.json            exports: ".", "./node"
  src/index.ts            public exports of core
  src/core/errors.ts      LoomError, codes
  src/core/disposables.ts DisposableStore
  src/core/definitions.ts definePlugin, createServiceRef, createHook, createExtension, attach + types
  src/core/manifest.ts    zod schema + validatePlugin
  src/core/graph.ts       resolveOrder, dependentsOf
  src/core/services.ts    ServiceRegistry
  src/core/hooks.ts       HookRegistry
  src/core/events.ts      EventBus
  src/core/tree.ts        buildTree
  src/core/context.ts     createPluginContext
  src/core/kernel.ts      createKernel (public facade)
  src/core/reconcile.ts   planReconcile, applyReconcile
  src/core/plugins-service.ts PluginsRef implementation
  src/rpc/protocol.ts     message types
  src/rpc/endpoint.ts     createRpcEndpoint
  src/rpc/remote-services.ts exposeServices, connectServices
  src/rpc/remote-hooks.ts exposeHooks, tapRemote
  src/rpc/memory-transport.ts createMemoryTransportPair (tests + same-process use)
  src/node/loader.ts      loadPluginsFromDirs
  test/**                 one test file per src file, *.test.ts; bench/*.bench.ts
packages/sdk/
  src/index.ts            re-exports
  etc/sdk.api.md          api-extractor report
  test/e2e.test.ts        example plugin using all four mechanisms
```

---

### Task 1: Repository scaffold, tooling, GitHub repo

**Files:**
- Create: root files listed above, `packages/kernel/package.json`, `packages/kernel/src/index.ts`, `packages/sdk/package.json`, `packages/sdk/src/index.ts`, `packages/kernel/test/smoke.test.ts`, `README.md`, `LICENSE` (MIT), `.gitignore`, `.changeset/config.json`
- Move: existing `docs/` stays at repo root

**Interfaces:**
- Produces: workspace scripts `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:coverage`, `pnpm bench`, `pnpm check` (all of the above + depcruise + knip).

- [ ] **Step 1: `git init` in the project root, create `.gitignore` (node_modules, dist, coverage, .turbo).**
- [ ] **Step 2: Write root configs.** `tsconfig.base.json` with the Global Constraints compiler flags and `"target": "ES2023"`, `"module": "NodeNext"`. ESLint flat config: typescript-eslint `strictTypeChecked`, `max-lines`, `max-lines-per-function`, eslint-plugin-boundaries with elements `kernel-core` (`packages/kernel/src/core`), `kernel-rpc`, `kernel-node`, `sdk`; rules: core may import only core; rpc may import core; node may import core; sdk may import kernel public entry only. `no-restricted-imports` for `node:*` in core and rpc. dependency-cruiser: `no-circular`. Vitest workspace with coverage thresholds 95.
- [ ] **Step 3: Write failing smoke test** `packages/kernel/test/smoke.test.ts`: `expect(typeof createKernel).toBe("function")` importing from `../src/index.js`.
- [ ] **Step 4: Run** `pnpm test` → FAIL (`createKernel` not exported).
- [ ] **Step 5: Export a placeholder `createKernel` that throws `new Error("not implemented")`**, run `pnpm test` → PASS; run `pnpm lint && pnpm typecheck` → clean.
- [ ] **Step 6: CI** `.github/workflows/ci.yml`: on push/PR, Node 22 and 24 matrix, `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm test:coverage`, upload coverage artifact.
- [ ] **Step 7: Commit** `chore: scaffold monorepo and tooling`.
- [ ] **Step 8: Create GitHub repo and push:** `gh repo create Alexandr-Obraztsov/loom --public --source . --push`. Verify CI run is green with `gh run watch`.

### Task 2: Errors and disposables

**Files:** Create `src/core/errors.ts`, `src/core/disposables.ts`; Test `test/core/errors.test.ts`, `test/core/disposables.test.ts`

**Interfaces:**
- Produces:
```ts
export type LoomErrorCode =
  | "MANIFEST_INVALID" | "DEPENDENCY_MISSING" | "DEPENDENCY_VERSION" | "DEPENDENCY_CYCLE"
  | "UNTRUSTED" | "SERVICE_CONFLICT" | "SERVICE_MISSING" | "UNDECLARED_DEPENDENCY"
  | "EXTENSION_CONFLICT" | "EXTENSION_INPUT_MISMATCH" | "EXTENSION_FACTORY_FAILED"
  | "SETUP_FAILED" | "TAP_FAILED" | "HOOK_TIMEOUT" | "INSTALL_DENIED"
  | "RPC_DISCONNECTED" | "RPC_REMOTE_ERROR" | "RPC_CANCELLED" | "DISPOSED";
export class LoomError extends Error { readonly code: LoomErrorCode; readonly pluginIds: readonly string[]; readonly details?: unknown; }
export class DisposableStore { add(fn: () => void | Promise<void>): () => void; dispose(): Promise<void>; readonly disposed: boolean; }
```

- [ ] **Step 1: Failing tests:** `LoomError carries code, pluginIds, details and is instanceof Error`; `DisposableStore disposes in reverse order of add`; `dispose collects errors from all disposers and rethrows one AggregateError after running every disposer`; `add after dispose runs the disposer immediately`; `returned remover prevents that disposer from running`; `dispose is idempotent`.
- [ ] **Step 2: Run** `pnpm --filter @loom/kernel test errors disposables` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(kernel): errors and disposables`.

### Task 3: Definitions and manifest validation

**Files:** Create `src/core/definitions.ts`, `src/core/manifest.ts`; Test `test/core/manifest.test.ts`

**Interfaces:**
- Produces:
```ts
export interface ServiceRef<T> { readonly id: string; readonly kind: "service"; readonly __type?: T }
export function createServiceRef<T>(id: string): ServiceRef<T>;
export interface HookRef<C, R> { readonly id: string; readonly kind: "hook"; readonly mode: "sync" | "async"; readonly __types?: [C, R] }
export function createHook<C, R>(id: string, opts?: { mode?: "sync" | "async" }): HookRef<C, R>; // default "async"
export interface InputSpec { multiple?: boolean; required?: boolean; schema?: import("zod").ZodType }
export interface ExtensionContext<I> { inputs: I; use<T>(ref: ServiceRef<T>): T; config: unknown }
export interface ExtensionDefinition<O = unknown> {
  id: string; attachTo?: { id: string; input: string }; inputs?: Record<string, InputSpec>;
  order?: number; factory(ctx: ExtensionContext<Record<string, ResolvedNode | ResolvedNode[] | undefined>>): O;
}
export function createExtension<O>(def: ExtensionDefinition<O>): ExtensionDefinition<O>;
export function attach<O>(parentId: string, input: string, value: O & { id?: string }, opts?: { order?: number }): ExtensionDefinition<O>;
  // id = `${parentId}/${input}/${value.id ?? stableHash(value)}`
export interface PluginDefinition {
  id: string; version: string; scope?: "builtin" | "user" | "project";
  dependsOn?: Record<string, string>; optionalDependsOn?: Record<string, string>; // id -> semver range
  startup?: Record<string, unknown>;
  setup?(ctx: PluginContext): void | Promise<void>;
  extensions?: readonly ExtensionDefinition[]; overrides?: readonly ExtensionDefinition[];
}
export function definePlugin(def: PluginDefinition): PluginDefinition;
export function validatePlugin(def: unknown): PluginDefinition; // throws LoomError MANIFEST_INVALID listing every issue
```
`PluginContext` and `ResolvedNode` are declared as types here and implemented in Tasks 8–9.

- [ ] **Step 1: Failing tests:** `accepts a minimal plugin {id, version}`; `rejects id not matching /^[a-z][a-z0-9-]*(\/[a-z0-9-]+)?$/` (scoped ids allowed `acme/jira`); `rejects non-semver version`; `rejects invalid range in dependsOn`; `rejects plugin listing itself as dependency`; `rejects same id in dependsOn and optionalDependsOn`; `rejects duplicate extension ids inside one plugin`; `error lists all issues, not only the first (details.issues.length === 3 for three defects)`; `attach() builds id parent/input/value.id`; `attach() without value.id gives the same id for structurally equal values`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** with zod; `stableHash` = FNV-1a over a key-sorted JSON of non-function fields plus function names. **Step 4: Run** → PASS. **Step 5: Commit** `feat(kernel): plugin definitions and validation`.

### Task 4: Dependency graph

**Files:** Create `src/core/graph.ts`; Test `test/core/graph.test.ts`, `test/core/graph.property.test.ts`

**Interfaces:**
- Produces:
```ts
export interface ResolvedOrder { order: readonly PluginDefinition[]; skippedOptional: ReadonlyMap<string, string[]> }
export function resolveOrder(plugins: readonly PluginDefinition[]): ResolvedOrder; // throws DEPENDENCY_MISSING | DEPENDENCY_VERSION | DEPENDENCY_CYCLE
export function dependentsOf(ids: Iterable<string>, plugins: readonly PluginDefinition[]): Set<string>; // transitive, includes optional edges, includes the ids themselves
```

- [ ] **Step 1: Failing tests:** `orders dependencies before dependents`; `order is deterministic: ties broken by id ascending regardless of input order`; `missing required dependency throws DEPENDENCY_MISSING with both ids`; `version outside range throws DEPENDENCY_VERSION with required range and actual version`; `optional dependency absent is skipped and reported in skippedOptional`; `optional dependency present orders before dependent and its version is checked`; `cycle throws DEPENDENCY_CYCLE whose pluginIds are the cycle path in order`; `self-contained duplicate plugin ids throw MANIFEST_INVALID`; `dependentsOf returns transitive closure including optional edges`.
- [ ] **Step 2: Property tests (fast-check, 500 runs):** for random DAGs, every plugin appears after all its present dependencies; output is a permutation of input; result is identical for any shuffle of input.
- [ ] **Step 3: Run** → FAIL. **Step 4: Implement** Kahn's algorithm with a min-heap keyed by id; cycle path recovered by DFS on the remaining nodes. O(V + E log V). **Step 5: Run** → PASS. **Step 6: Commit** `feat(kernel): dependency resolution`.

### Task 5: Service registry

**Files:** Create `src/core/services.ts`; Test `test/core/services.test.ts`

**Interfaces:**
- Consumes: `ServiceRef`, `LoomError`.
- Produces:
```ts
export interface ServiceRegistry {
  provide<T extends object>(ref: ServiceRef<T>, impl: T, owner: string): () => void;
  override<T extends object>(ref: ServiceRef<T>, impl: T, owner: string): () => void;
  decorate<T extends object>(ref: ServiceRef<T>, fn: (prev: T) => T, owner: string): () => void;
  use<T extends object>(ref: ServiceRef<T>, consumer: string, allowed: ReadonlySet<string>): T; // live proxy
  has(ref: ServiceRef<unknown>): boolean;
  providerOf(ref: ServiceRef<unknown>): string | undefined;
  removeOwner(owner: string): void;
  onChange(listener: (refId: string) => void): () => void;
}
export function createServiceRegistry(opts: { winners?: Readonly<Record<string, string>>; kernelOwner: string }): ServiceRegistry;
```
Rules: one `provide` per ref unless `winners[ref.id]` names the winner (loser registration is kept inactive and becomes active if the winner is removed); `override` beats `provide`; two overrides of one ref without a winner → `SERVICE_CONFLICT` naming both owners; decorators apply in registration order on top of the active impl; `use` checks the active provider's owner is in `allowed`, equals `consumer`, or equals `kernelOwner`, else `UNDECLARED_DEPENDENCY`.

- [ ] **Step 1: Failing tests:** `use returns provided impl methods`; `second provide throws SERVICE_CONFLICT naming both owners`; `winners config activates the named provider and keeps the other as fallback`; `override replaces provide, removing override restores provide`; `two overrides without winner throw SERVICE_CONFLICT`; `decorators stack in order and wrap the current impl`; `proxy obtained before override calls the override` (Review Focus 2); `proxy call after provider removed throws SERVICE_MISSING`; `use of service whose provider is not in allowed throws UNDECLARED_DEPENDENCY`; `kernel-owned services are usable by anyone`; `removeOwner drops provides, overrides and decorators of that owner`; `onChange fires with ref id on every activation change`; `methods are bound: destructured method keeps this`; `resolved impl is cached until a change (decorator fn runs once per change, not per call)`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** live proxy as `Proxy` over an empty target whose `get` reads a per-ref cache `{ version, impl }` invalidated by a global version counter on change; functions returned bound to the impl. **Step 4: Run** → PASS. **Step 5: Commit** `feat(kernel): service registry with live proxies`.

### Task 6: Hook registry

**Files:** Create `src/core/hooks.ts`; Test `test/core/hooks.test.ts`, `test/core/hooks.property.test.ts`

**Interfaces:**
- Consumes: `HookRef`, `LoomError`.
- Produces:
```ts
export type Next<C, R> = (ctx: C) => R;
export interface TapOptions<C> { priority?: number; before?: readonly string[]; after?: readonly string[]; match?: (ctx: C) => boolean }
export interface HookRegistry {
  tap<C, R>(hook: HookRef<C, R>, owner: string, opts: TapOptions<C>, fn: (ctx: C, next: Next<C, R>) => R): () => void;
  run<C, R>(hook: HookRef<C, R>, ctx: C, fallback: (ctx: C) => R): R; // async hooks return Promise<R>
  removeOwner(owner: string): void;
  taps(hook: HookRef<unknown, unknown>): readonly { owner: string }[]; // ordered, for introspection
}
export function createHookRegistry(opts: { onError(err: LoomError): void }): HookRegistry;
```
Order: constraints `before`/`after` (owner ids) form a DAG over taps; within the DAG, higher `priority` first, then earlier registration. Contradictory constraints → the later-registered tap's constraint is ignored and `onError` receives `TAP_FAILED` naming both owners. A tap that throws: error wrapped as `TAP_FAILED` with owner, passed to `onError`, and rethrown to the caller of `run`. `next` called twice in one tap → second call throws `TAP_FAILED`. Sync hook taps returning a Promise → `TAP_FAILED`.

- [ ] **Step 1: Failing tests:** `run with no taps calls fallback`; `taps run in priority order`; `after/before constraints override priority`; `match=false skips the tap and continues the chain`; `tap can change ctx passed to next`; `tap can change result returned by next`; `tap that does not call next short-circuits`; `async hook awaits each tap`; `throwing tap reports TAP_FAILED with owner and rethrows`; `calling next twice throws TAP_FAILED`; `sync hook rejects a Promise-returning tap`; `contradictory before/after reports and still runs every tap once`; `removeOwner removes all taps of owner`; `ordering cache is reused across runs (sort runs once per change, spy)`.
- [ ] **Step 2: Property tests:** for random sets of taps with random priorities and acyclic before/after, every constraint holds in `taps()` order and each tap runs exactly once per `run`.
- [ ] **Step 3: Run** → FAIL. **Step 4: Implement**; chain built as an index-based closure without allocating per-tap arrays on each run. **Step 5: Run** → PASS. **Step 6: Commit** `feat(kernel): hook pipelines`.

### Task 7: Event bus

**Files:** Create `src/core/events.ts`; Test `test/core/events.test.ts`

**Interfaces:**
- Produces:
```ts
export interface EventBus {
  on<P>(type: string, owner: string, listener: (payload: P) => void): () => void;
  emit<P>(type: string, payload: P): void;
  removeOwner(owner: string): void;
}
export function createEventBus(opts: { onError(err: LoomError): void }): EventBus;
```
Delivery is synchronous in subscription order; a throwing listener is reported via `onError` (`TAP_FAILED`, owner) and does not stop other listeners; listeners added during emit are not called for that emit; removed during emit are not called if not yet reached.

- [ ] **Step 1: Failing tests** for each rule above plus `emit with no listeners is a no-op` and `removeOwner removes only that owner's listeners`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** with `Map<string, Listener[]>` copy-on-write. **Step 4: Run** → PASS. **Step 5: Commit** `feat(kernel): event bus`.

### Task 8: Extension tree

**Files:** Create `src/core/tree.ts`; Test `test/core/tree.test.ts`

**Interfaces:**
- Consumes: `ExtensionDefinition`, `LoomError`.
- Produces:
```ts
export interface ResolvedNode<O = unknown> {
  readonly id: string; readonly pluginId: string; readonly value: O | undefined;
  readonly inputs: Readonly<Record<string, ResolvedNode | readonly ResolvedNode[] | undefined>>;
  readonly error?: LoomError;
}
export interface TreeConfig { rootId?: string; disabled?: readonly string[]; attach?: Readonly<Record<string, { id: string; input: string }>>; winners?: Readonly<Record<string, string>> }
export interface TreeResult { root: ResolvedNode | undefined; orphans: readonly { id: string; pluginId: string; reason: LoomError }[]; errors: readonly LoomError[] }
export function buildTree(
  entries: readonly { pluginId: string; ext: ExtensionDefinition; override: boolean }[],
  config: TreeConfig, use: ExtensionContext<never>["use"], previous?: TreeResult,
): TreeResult;
```
Rules: root id defaults to `"app"`; override with same id replaces the original (two overrides without winner → node error `EXTENSION_CONFLICT`); `disabled` removes the node and its subtree (subtree children become orphans with reason); `attach` config replaces `attachTo`; missing parent or unknown input → orphan; `multiple: false` input with >1 child → node error `EXTENSION_CONFLICT` on the parent listing children; required input empty → node error; schema failure → child node `error: EXTENSION_INPUT_MISMATCH` and excluded from parent's inputs; factory throw → node `error: EXTENSION_FACTORY_FAILED`, value undefined; children ordered by `order` asc then id. Structural sharing: if the extension object, its config entry and all child nodes are identical (`===`) to `previous`, return the previous node object without calling `factory`.

- [ ] **Step 1: Failing tests:** one test per rule above, plus `factory receives resolved inputs`, `cycle in attachTo produces orphans with DEPENDENCY_CYCLE instead of infinite recursion`, `unchanged subtree reuses previous node objects and does not call factory (spy)`, `changing one leaf re-creates only its ancestors (identity checks)`, Review Focus 5 test: `throwing factory leaves siblings and parent intact`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** index of children by `parent:input` built once per build (O(n)); recursive resolve with a visiting set for cycles. **Step 4: Run** → PASS. **Step 5: Commit** `feat(kernel): extension tree with structural sharing`.

### Task 9: Plugin context and setup lifecycle

**Files:** Create `src/core/context.ts`; Test `test/core/context.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 5, 6, 7.
- Produces:
```ts
export interface PluginContext {
  readonly id: string; readonly config: unknown; readonly state: Record<string, unknown>;
  provide<T extends object>(ref: ServiceRef<T>, impl: T): void;
  override<T extends object>(ref: ServiceRef<T>, impl: T): void;
  decorate<T extends object>(ref: ServiceRef<T>, fn: (prev: T) => T): void;
  use<T extends object>(ref: ServiceRef<T>): T;
  tap<C, R>(hook: HookRef<C, R>, opts: TapOptions<C>, fn: (ctx: C, next: Next<C, R>) => R): void;
  run<C, R>(hook: HookRef<C, R>, ctx: C, fallback: (ctx: C) => R): R;
  on<P>(type: string, listener: (p: P) => void): void;
  emit<P>(type: string, payload: P): void;
  onDispose(fn: () => void | Promise<void>): void;
}
export function createPluginContext(args: {
  plugin: PluginDefinition; allowed: ReadonlySet<string>; config: unknown; state: Record<string, unknown>;
  services: ServiceRegistry; hooks: HookRegistry; events: EventBus;
}): { ctx: PluginContext; dispose(): Promise<void> };
```
`allowed` = dependsOn ids ∪ present optionalDependsOn ids. `dispose()` runs `onDispose` callbacks (reverse order) then removes the owner from services, hooks and events. Any context method called after dispose throws `DISPOSED`.

- [ ] **Step 1: Failing tests:** `registrations are attributed to the plugin id`; `dispose removes services, taps, listeners and runs onDispose in reverse`; `use of undeclared plugin's service throws UNDECLARED_DEPENDENCY`; `use of optional dependency's service works when present`; `state object is the same instance passed in`; `methods after dispose throw DISPOSED`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. **Step 5: Commit** `feat(kernel): scoped plugin context`.

### Task 10: Kernel and reconcile

**Files:** Create `src/core/kernel.ts`, `src/core/reconcile.ts`, `src/core/plugins-service.ts`; Test `test/core/kernel.test.ts`, `test/core/reconcile.test.ts`, `test/core/plugins-service.test.ts`

**Interfaces:**
- Consumes: Tasks 2–9.
- Produces:
```ts
export interface KernelConfig extends TreeConfig { plugins?: Readonly<Record<string, unknown>> }
export interface KernelOptions { config?: KernelConfig; trust?(plugin: PluginDefinition): boolean | Promise<boolean> }
export interface ReconcileDiff { added: string[]; removed: string[]; reloaded: string[]; requiresRestart: string[] }
export interface Kernel {
  reconcile(desired: readonly PluginDefinition[]): Promise<ReconcileDiff>;
  readonly plugins: readonly PluginDefinition[];       // active, in resolved order
  readonly tree: TreeResult;
  readonly services: Pick<ServiceRegistry, "use" | "has" | "providerOf">; // use() here acts as kernel owner
  run: HookRegistry["run"]; on: EventBus["on"];
  setConfig(config: KernelConfig): Promise<void>;     // re-runs reconcile with same plugins
  dispose(): Promise<void>;
}
export function createKernel(options?: KernelOptions): Kernel;

export const KERNEL_ID = "kernel";
export interface PluginsService {
  install(def: PluginDefinition): Promise<ReconcileDiff>;
  uninstall(id: string): Promise<ReconcileDiff>;
  enable(id: string): Promise<ReconcileDiff>;
  disable(id: string): Promise<ReconcileDiff>;
  reload(def: PluginDefinition): Promise<ReconcileDiff>;
  list(): readonly { id: string; version: string; enabled: boolean }[];
}
export const PluginsRef: ServiceRef<PluginsService>;
export const BeforeInstallHook: HookRef<{ plugin: PluginDefinition }, { allow: boolean; reason?: string }>;
// events: "plugins.changed" (ReconcileDiff), "plugins.failed" ({ error: LoomError }), "kernel.error" (LoomError)
```
Reconcile algorithm (spec 4.4): validate all → filter untrusted `project` scope (`UNTRUSTED`, reported, not fatal) → `resolveOrder` → diff by id with "changed" = different object or version → affected = `dependentsOf(changed ∪ removed)` → snapshot old defs + states → dispose affected in reverse order → setup affected ∪ added in order → on any throw: dispose those set up in this pass, re-setup the snapshot in order, emit `plugins.failed`, rethrow `SETUP_FAILED` naming the plugin → rebuild tree with `previous` → emit `plugins.changed`. `requiresRestart` lists reloaded plugins whose `startup` changed (deep-equal). Conflicts detected during setup (e.g. `SERVICE_CONFLICT`) roll back the same way. Calls are serialized via a promise queue. `PluginsService.install` runs `BeforeInstallHook` first; `allow: false` → `INSTALL_DENIED`.

- [ ] **Step 1: Failing tests (reconcile):** `first reconcile sets up plugins in dependency order`; `adding a plugin sets up only it`; `changing a plugin reloads it and its dependents, not unrelated ones`; `removing a plugin disposes it and its dependents' registrations are gone`; `state survives reload of the same id and is dropped on removal`; Review Focus 1: `setup throwing in the 3rd plugin rolls back the first two and restores previous versions with their state`; `SERVICE_CONFLICT during setup rolls back`; Review Focus 4: `concurrent reconcile calls apply in order (second sees result of first)`; `untrusted project plugin is skipped and reported via kernel.error`; `requiresRestart lists plugins whose startup changed`; `tree reflects extensions of active plugins after each reconcile`; `optional dependency added later makes its dependent reload so it can use the new service`.
- [ ] **Step 2: Failing tests (kernel/plugins service):** `PluginsRef is usable by any plugin without declaring a dependency`; `install runs BeforeInstallHook and rejects with INSTALL_DENIED`; `disable keeps definition but removes it from active set`; `setConfig with new disabled list rebuilds tree without re-running setup (spy)`; `dispose disposes all plugins in reverse order and further calls throw DISPOSED`.
- [ ] **Step 3: Run** → FAIL. **Step 4: Implement** `reconcile.ts` as a pure `planReconcile(current, desired) → Plan` plus `applyReconcile(plan, runtime)`; kernel holds runtime state. **Step 5: Run** → PASS. **Step 6: Commit** `feat(kernel): kernel and live reconcile`.

### Task 11: Cross-process RPC

**Files:** Create `src/rpc/protocol.ts`, `src/rpc/endpoint.ts`, `src/rpc/remote-services.ts`, `src/rpc/remote-hooks.ts`, `src/rpc/memory-transport.ts`; Test `test/rpc/*.test.ts`

**Interfaces:**
- Consumes: Task 10 `Kernel`, Task 5/6 registries.
- Produces:
```ts
export interface Transport { send(msg: RpcMessage): void; onMessage(cb: (msg: RpcMessage) => void): () => void; onClose(cb: () => void): () => void }
export function createMemoryTransportPair(): [Transport, Transport]; // async delivery via queueMicrotask, structuredClone of payloads
export interface RpcEndpoint { call(target: string, method: string, args: unknown[], signal?: AbortSignal): Promise<unknown>; handle(target: string, impl: (method: string, args: unknown[], signal: AbortSignal) => Promise<unknown>): () => void; close(): void }
export function createRpcEndpoint(transport: Transport): RpcEndpoint;
export function exposeServices(kernel: Kernel, endpoint: RpcEndpoint, refs: readonly ServiceRef<object>[]): () => void;
export function connectServices(kernel: Kernel, endpoint: RpcEndpoint, refs: readonly ServiceRef<object>[], owner: string): () => void;
  // provides each ref in the local kernel as an async proxy: every method returns Promise
export function exposeHooks(kernel: Kernel, endpoint: RpcEndpoint, hooks: readonly HookRef<unknown, unknown>[]): () => void;
export function tapRemote<C, R>(ctx: PluginContext, endpoint: RpcEndpoint, hook: HookRef<C, R>, opts: TapOptions<C> & { timeoutMs?: number }, fn: (c: C, next: Next<C, R>) => Promise<R>): void;
  // default timeoutMs 5000; on timeout: emits kernel.error HOOK_TIMEOUT naming owner and continues with next(ctx)
```
Protocol messages: `call`, `result`, `error` (serialized `LoomError` code/message/pluginIds), `cancel`, `tap-invoke`, `tap-next`, `tap-result`. Only `async` hooks can be tapped remotely; tapping a `sync` hook throws `TAP_FAILED`.

- [ ] **Step 1: Failing tests:** `remote service method call returns value`; `remote LoomError arrives with same code and pluginIds`; `AbortSignal abort sends cancel and rejects with RPC_CANCELLED; handler sees aborted signal`; `transport close rejects pending calls with RPC_DISCONNECTED`; `connectServices proxy follows provider changes on the remote side`; `remote tap can modify ctx and result`; Review Focus 3: `hanging remote tap times out, run continues with next, kernel.error HOOK_TIMEOUT names owner`; `remote tap on sync hook throws TAP_FAILED`; `non-cloneable argument rejects with RPC_REMOTE_ERROR instead of throwing synchronously`; `disposing plugin that tapped remotely removes the remote tap`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; request ids as incrementing integers per endpoint; pending map cleaned on settle. **Step 4: Run** → PASS. **Step 5: Commit** `feat(kernel): cross-process rpc for services and hooks`.

### Task 12: Node package loader

**Files:** Create `src/node/loader.ts`; Test `test/node/loader.test.ts` (fixtures written to a temp dir in the test)

**Interfaces:**
- Produces:
```ts
export interface LoadedPlugin { definition: PluginDefinition; dir: string; entry: string }
export interface LoadResult { plugins: LoadedPlugin[]; failures: { dir: string; error: LoomError }[] }
export function loadPluginsFromDirs(dirs: readonly { path: string; scope: "builtin" | "user" | "project" }[], opts: { entry: "main" | "renderer"; cacheBust?: boolean }): Promise<LoadResult>;
```
Reads each immediate subdirectory's `package.json`; uses the `loom` field (`{ id, main?, renderer? }`); dynamic-imports the entry (`?v=<mtime>` when `cacheBust`); takes the default export as `PluginDefinition`, sets `scope` from the dir; validates with `validatePlugin`; ids in `package.json` and in the definition must match. A broken package lands in `failures`, never throws.

- [ ] **Step 1: Failing tests:** `loads a plugin with main entry`; `skips directories without loom field`; `reports id mismatch as MANIFEST_INVALID failure`; `reports import error as failure and still loads others`; `missing entry for requested process is skipped, not a failure`; `cacheBust loads the new code after file change`; `scope is taken from the directory group`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** with `node:fs/promises` and `node:url` `pathToFileURL`. **Step 4: Run** → PASS. **Step 5: Commit** `feat(kernel): node plugin loader`.

### Task 13: SDK facade and end-to-end example

**Files:** Modify `packages/sdk/src/index.ts`; Create `packages/sdk/api-extractor.json`, `packages/sdk/etc/sdk.api.md`; Test `packages/sdk/test/e2e.test.ts`

**Interfaces:**
- Produces: `@loom/sdk` re-exports exactly: `definePlugin`, `createServiceRef`, `createHook`, `createExtension`, `attach`, `LoomError`, `PluginsRef`, `BeforeInstallHook`, and types `PluginDefinition`, `PluginContext`, `ServiceRef`, `HookRef`, `TapOptions`, `Next`, `ExtensionDefinition`, `ResolvedNode`, `InputSpec`, `LoomErrorCode`. Nothing else.

- [ ] **Step 1: Failing e2e test** `four mechanisms work together`: plugin `base` declares `app` extension with input `panels` (multiple) and hook `base.submit` and service `base.store`; plugin `demo` (dependsOn `base`) attaches a panel, taps `base.submit` to uppercase text, provides `demo.counter`, listens to `base.submitted`. Assertions: tree `app.inputs.panels[0].value.title === "Demo"`; `run(submit, {text:"hi"})` returns `"HI"`; event received; after `reconcile([base])` the panel, tap and listener are gone.
- [ ] **Step 2: Failing test** `sdk exports only the public surface` — `Object.keys(await import("@loom/sdk")).sort()` equals the list above.
- [ ] **Step 3: Run** → FAIL. **Step 4: Implement re-exports; run `api-extractor run --local`** and commit `etc/sdk.api.md`. Add `pnpm api:check` (api-extractor without `--local`) to `pnpm check`.
- [ ] **Step 5: Run** → PASS. **Step 6: Commit** `feat(sdk): public facade and api report`.

### Task 14: Performance, coverage gate, docs

**Files:** Create `packages/kernel/bench/*.bench.ts`, `packages/kernel/test/perf.test.ts`, `docs/kernel/README.md`; Modify root `README.md`

**Interfaces:** none new.

- [ ] **Step 1: Benchmarks** (`vitest bench`): `reconcile 200 plugins, 3 deps each, cold`; `reload 1 leaf plugin among 200`; `hook run, 20 taps, async`; `service call through live proxy vs direct`; `buildTree 2000 extensions cold` and `rebuild after 1 leaf change`.
- [ ] **Step 2: Failing guard tests** in `perf.test.ts` (generous ceilings, run on CI): cold reconcile of 200 plugins < 50 ms; reload of 1 leaf < 5 ms; rebuild after 1 leaf change calls `factory` for ≤ depth+1 nodes; live proxy call overhead < 5× direct call over 1e6 calls; 20-tap async run < 0.05 ms per run averaged over 10 000 runs.
- [ ] **Step 3: Run**, profile any failing guard (`node --cpu-prof`), optimize, re-run → PASS. Record numbers in `docs/kernel/README.md`.
- [ ] **Step 4: Run** `pnpm test:coverage` → thresholds ≥ 95 pass; add tests for any uncovered branch reported.
- [ ] **Step 5: Docs:** `docs/kernel/README.md` — concepts with one example each, error code table, reconcile guarantees, perf numbers. Root `README.md` — what Loom is, status, how to run checks.
- [ ] **Step 6: Run** `pnpm check && pnpm test:coverage` → green. **Commit** `perf(kernel): benchmarks, guards and docs`, push, confirm CI green with `gh run watch`.
