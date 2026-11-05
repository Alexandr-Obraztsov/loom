# Loom Minimal Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Electron window where the user picks a project folder and chats with Claude Code through Loom plugins: messages, agent replies, tool calls, permission prompts.

**Architecture:** `apps/desktop` runs one `@loom/kernel` in the Electron main process and one in the renderer, linked by the kernel RPC over a `MessagePort`. Seven plugins under `plugins/*` (separate workspace packages) provide storage, the ACP client, the Claude Code agent, the root, the bare layout, chat and composer; `builds/minimal` lists them and the desktop app bundles their entries statically through Vite virtual modules. `@loom/react` renders the kernel's extension tree.

**Tech Stack:** Electron (current stable ≥ 2 weeks old), electron-vite, React 19, TypeScript 5.9 strict ESM, `@agentclientprotocol/sdk` (v1 stable entry), `@agentclientprotocol/claude-agent-acp`, Vitest + Testing Library + happy-dom, Playwright (`_electron`) for one smoke test.

**Spec:** `docs/superpowers/specs/2026-11-04-loom-design.md` — sections 6.1, 6.2, 10b, 11a. Kernel docs: `docs/kernel/README.md`.

## Global Constraints

- Packages in `packages/*` never import `plugins/*` or `apps/*` (lint).
- Plugin code imports only `@loom/sdk`, `@loom/host`, `@loom/react`, React, its own third-party deps, and the public entry of plugins listed in its `dependsOn`. Main entries may use Node built-ins; renderer entries may use DOM/React and must not import Node built-ins.
- Every plugin package: `package.json` with `"loom": { "id": "<id>", "main"?: "<built path>", "renderer"?: "<built path>" }`; entries default-export `definePlugin(...)`; plugin ids exactly: `storage`, `acp`, `claude-code`, `app`, `layout-bare`, `chat`, `composer`.
- Coverage ≥ 95% (statements, branches, functions, lines) per package for `packages/react` and each `plugins/*`; `apps/desktop` is covered by the smoke test only. Test/coverage scripts run "all projects except perf" (no project enumeration).
- Existing kernel/sdk behavior and their tests stay unchanged except Task 1.
- Commit messages end with a Co-Authored-By trailer naming the model that wrote the commit.
- UI copy in Russian.

## Review Focus

1. **Agent process fails to start or exits mid-session** (claude-agent-acp missing, not logged in, crash) — the chat shows a readable error with the agent's stderr tail and no hung "thinking" state; sending again retries. Test owned by Task 3.
2. **User closes the window or the renderer reloads while a prompt is running** — main cancels the session turn, pending permission requests resolve as cancelled, no orphan agent processes remain after app quit. Tests owned by Tasks 3 and 8.
3. **Permission request arrives while the renderer is not polling** (between long-poll calls) — it is not lost; it appears on the next `waitUpdates` and the agent keeps waiting until answered or cancelled. Test owned by Task 3.
4. **Very long agent reply streamed in many chunks** — chunks are merged into one message (not one bubble per chunk) and the UI stays responsive (updates batched). Tests owned by Tasks 3 and 6.
5. **User sends while a turn is running** — composer disables Send and shows Stop; a second prompt is not sent concurrently. Test owned by Task 7.

---

## File Structure

```
packages/kernel/src/rpc/remote-services.ts        (Task 1: prototype-chain member lookup)
packages/kernel/src/core/kernel.ts                (Task 1: hostServices option)
packages/host/                                     @loom/host: HostRef
packages/react/                                    @loom/react
  src/index.ts  src/provider.tsx  src/render.tsx  src/hooks.ts
plugins/storage/   src/main.ts  test/
plugins/acp/       src/main.ts  src/sessions.ts  src/updates.ts  src/permissions.ts  src/renderer.ts  src/api.ts  test/
plugins/claude-code/ src/main.ts  test/
plugins/app/       src/renderer.tsx  src/api.ts  test/
plugins/layout-bare/ src/renderer.tsx  test/
plugins/chat/      src/renderer.tsx  src/timeline.tsx  src/items.tsx  src/api.ts  test/
plugins/composer/  src/renderer.tsx  test/
builds/minimal/    package.json  loom.config.json
apps/desktop/      electron.vite.config.ts  src/main/index.ts  src/main/transport.ts  src/main/project.ts
                   src/preload/index.ts  src/renderer/index.html  src/renderer/main.tsx  src/renderer/transport.ts
                   vite/loom-build.ts  e2e/smoke.test.ts  e2e/stub-agent.mjs
```

---

### Task 1: Kernel fixes for the host: class-instance RPC (R21), host services, `@loom/host`

**Files:** Modify `packages/kernel/src/rpc/remote-services.ts:22`, `packages/kernel/src/core/kernel.ts` (+ runtime as needed), `docs/kernel/README.md`; Create `packages/host/{package.json, src/index.ts}`; Tests in `packages/kernel/test/rpc/remote-services.test.ts`, `packages/kernel/test/core/kernel.host.test.ts`.

**Interfaces:**
- `exposeServices` resolves a member by walking the prototype chain of the current impl up to (excluding) `Object.prototype` and `Function.prototype`, reading own property descriptors without invoking accessors; `constructor` and `__proto__` always rejected with RPC_REMOTE_ERROR.
- `createKernel({ ..., hostServices?: readonly (readonly [ServiceRef<object>, object])[] })` — each pair is provided by the kernel owner before the first reconcile, so any plugin may `use` it without declaring a dependency (same rule as PluginsRef).
- `@loom/host` (new package, depends only on `@loom/kernel` types):
```ts
export interface Host { readonly process: "main" | "renderer"; readonly projectDir: string; readonly dataDir: string; readonly endpoint: RpcEndpoint }
export const HostRef: ServiceRef<Host>;   // id "host"
```
Plugins may import `@loom/host` (add to the plugin import allow-list in Task 2).

- [ ] **Step 1: Failing tests:** `class-instance service method is callable over rpc` (`provide(Ref, new Counter())`, `Counter.prototype.inc` returns 1); `inherited method from a base class is callable`; `getter on the prototype is not invoked and is rejected`; existing `constructor`/`toString`/`hasOwnProperty` rejections still pass; `host service is usable by a plugin without dependsOn`; `host services survive reconcile and are removed on dispose`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/rpc/remote-services.test.ts packages/kernel/test/core/kernel.host.test.ts` → FAIL.
- [ ] **Step 3: Implement** `memberOf(service: object, name: string): unknown`, the `hostServices` option, and `@loom/host`.
- [ ] **Step 4: Run** → PASS; update docs/kernel/README.md ("Что можно вызвать", `hostServices`).
- [ ] **Step 5: Commit** `feat(kernel): host services and class-instance rpc`.

### Task 2: Workspace for plugins/apps/builds and `@loom/react`

**Files:** Modify `pnpm-workspace.yaml`, `eslint.rules.js`, `vitest.config.ts`, `knip.json`, `.dependency-cruiser.cjs`, root `package.json` scripts, `turbo.json`; Create `packages/react/**`; lint fixtures in `tools/lint-fixtures/` for the new rules.

**Interfaces:**
- Produces (`@loom/react`):
```ts
export function KernelProvider(props: { kernel: Kernel; children: ReactNode }): JSX.Element;
export function useKernel(): Kernel;
export function useService<T extends object>(ref: ServiceRef<T>): T;          // kernel.services.use
export function useHookRunner<C, R>(hook: HookRef<C, R>): (ctx: C, fallback: (c: C) => R) => R;
export function useTree(): TreeResult;                                         // re-renders on "plugins.changed"
export function Render(props: { node: ResolvedNode | undefined; fallback?: ReactNode }): JSX.Element | null;
export function RenderRoot(): JSX.Element | null;                              // <Render node={useTree().root} />
```
`Render`: if `node.error` → a placeholder `<div role="alert">Расширение «{id}» не загрузилось: {message}</div>`; else renders `(node.value as { component?: ComponentType<{ node: ResolvedNode }> }).component` with `node` prop; nodes without a component render null. Each `Render` wraps its child in an error boundary that renders the same placeholder; keys are node ids. `useTree` subscribes via `kernel.on("plugins.changed")` and uses `useSyncExternalStore`.
- Lint: elements `plugin-main` (`plugins/*/src/main.ts` and files it imports), `plugin-renderer` (`plugins/*/src/renderer.ts(x)` and siblings), `react-pkg`, `app`; rules per Global Constraints; `packages/*` → `plugins/*`|`apps/*` disallowed.

- [ ] **Step 1: Failing tests** `packages/react/test/render.test.tsx` (happy-dom): `RenderRoot renders the root component`; `node with error renders the alert placeholder naming the extension`; `component that throws renders the placeholder and siblings still render`; `tree change after reconcile re-renders`; `useService returns a live proxy (call after override hits new impl)`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** package + workspace/lint/test config (test scripts become "all projects except perf"); add lint fixtures proving `packages/*`→`plugins/*` is rejected and a renderer plugin importing `node:fs` is rejected. **Step 4: Run** `pnpm check && pnpm test:coverage` → PASS. **Step 5: Commit** `feat(react): kernel bindings and plugin workspace`.

### Task 3: `acp` plugin — main side

**Files:** Create `plugins/acp/{package.json, src/api.ts, src/main.ts, src/sessions.ts, src/updates.ts, src/permissions.ts}`, tests in `plugins/acp/test/` using the SDK's in-process `AgentApp` as a fake agent (`ClientApp.connect(agentApp)` path) and a spawned stub for process failures.

**Interfaces:**
- Produces (`plugins/acp/src/api.ts`, public entry for other plugins):
```ts
export interface AgentSpec { id: string; title: string; command: string; args: readonly string[]; env?: Readonly<Record<string, string>> }
export interface AgentRegistry { add(spec: AgentSpec): () => void; list(): readonly AgentSpec[] }
export const AgentRegistryRef: ServiceRef<AgentRegistry>;                       // id "acp.agents"
export type SessionItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "agent"; id: string; text: string }                                 // merged agent_message_chunk
  | { kind: "thought"; id: string; text: string }
  | { kind: "tool"; id: string; title: string; status: "pending" | "in_progress" | "completed" | "failed"; detail?: string }
  | { kind: "permission"; id: string; title: string; options: readonly { optionId: string; name: string; kind: string }[]; resolved?: string }
  | { kind: "error"; id: string; message: string; stderr?: string };
export interface SessionSnapshot { sessionId: string; seq: number; items: readonly SessionItem[]; busy: boolean }
export interface Sessions {
  ensure(opts: { agentId: string; cwd: string }): Promise<SessionSnapshot>;     // one session per window for now; idempotent
  prompt(sessionId: string, text: string): Promise<void>;                       // rejects AcpError "SESSION_BUSY" while busy
  cancel(sessionId: string): Promise<void>;
  respondPermission(sessionId: string, itemId: string, optionId: string | null): Promise<void>; // null = reject/cancel
  waitUpdates(sessionId: string, afterSeq: number, timeoutMs?: number): Promise<SessionSnapshot>; // resolves when seq > afterSeq or after timeoutMs (default 25000) with current snapshot
  close(sessionId: string): Promise<void>;
}
export const SessionsRef: ServiceRef<Sessions>;                                  // id "acp.sessions"
export const ToolCallHook: HookRef<{ sessionId: string; toolCall: unknown; options: readonly { optionId: string; kind: string }[] }, Promise<{ optionId: string } | null | undefined>>; // id "acp.toolCall"; undefined = ask the user
export const PromptHook: HookRef<{ sessionId: string; text: string }, Promise<string>>; // id "acp.prompt"
```
- Errors: plugin-level failures use `Error` subclasses with a `code` string (`"AGENT_START_FAILED" | "AGENT_EXITED" | "SESSION_BUSY" | "SESSION_UNKNOWN" | "AGENT_UNKNOWN"`) exported from api.ts as `AcpError`; they cross RPC as RPC_REMOTE_ERROR with the message (kernel codes stay closed).
- Behavior: spawn `command args` (`child_process.spawn`, stdio pipes) → `ndJsonStream` → `ClientApp` (stable v1). Advertise no fs/terminal capabilities. `session/update` → merged items (consecutive `agent_message_chunk` append to the last `agent` item; `tool_call`/`tool_call_update` upsert by toolCallId). Updates are applied in a 16 ms batch before bumping `seq` and waking waiters. Permission: run `ToolCallHook`; on `undefined` push a `permission` item and await `respondPermission` or cancel. `busy` true from prompt start to PromptResponse. Agent exit → `error` item with last 4 KB of stderr, pending prompt rejects, pending permissions resolve cancelled, session marked dead; next `prompt` restarts the agent (new session). `onDispose` kills all agent processes (SIGTERM, then SIGKILL after 2 s).

- [ ] **Step 1: Failing tests** (fake agent via `AgentApp`): `registry add with an existing id replaces it and the remover restores nothing else`; `ensure creates one session and is idempotent`; `agent chunks are merged into one agent item`; `tool call and its updates upsert one tool item`; `permission undecided by hooks appears as an item and resolves via respondPermission`; Review Focus 3: `permission requested while nobody waits is returned by the next waitUpdates`; `ToolCallHook allow skips the user`; `prompt while busy rejects SESSION_BUSY`; `cancel ends the turn and resolves pending permissions as cancelled`; `waitUpdates resolves after timeout with current snapshot`; Review Focus 1 (spawned stub `node -e` that exits 1 writing to stderr): `agent that exits shows an error item with stderr and the next prompt restarts it`; Review Focus 2: `dispose kills agent processes`; Review Focus 4: `200 chunks within one batch bump seq once`.
- [ ] **Step 2: Run** `pnpm exec vitest run plugins/acp` → FAIL. **Step 3: Implement** per Interfaces. Files ≤ 300 lines; split as listed. **Step 4: Run** → PASS, coverage ≥ 95%. **Step 5: Commit** `feat(acp): acp client plugin (main)`.

### Task 4: `acp` renderer entry, `claude-code` and `storage` plugins

**Files:** Create `plugins/acp/src/renderer.ts`; `plugins/claude-code/**`; `plugins/storage/**`; tests.

**Interfaces:**
- `acp` renderer: `definePlugin({ id: "acp", ... })` whose setup provides async proxies for `[SessionsRef, AgentRegistryRef]` over `use(HostRef).endpoint` (reuse the kernel's remote-services logic; if `remoteServicesPlugin` cannot take an endpoint lazily from a service, add an exported helper `provideRemoteServices(ctx, endpoint, refs)` in kernel rpc with a test). The main side (Task 8) exposes both refs with `exposeServices`.
- `claude-code` (main): `dependsOn: { acp: "^0.1.0" }`; setup adds `{ id: "claude-code", title: "Claude Code", command: process.execPath, args: [require.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js")], env: { ELECTRON_RUN_AS_NODE: "1" } }` to `AgentRegistryRef`.
- `storage` (main): `StorageRef: ServiceRef<{ scope(ns: string): { get<T>(k: string): Promise<T | undefined>; set(k: string, v: unknown): Promise<void>; delete(k: string): Promise<void>; keys(): Promise<string[]> } }>` (id `"storage"`), files `<dataDir>/storage/<ns>.json` (`dataDir` from `HostRef`); atomic write (temp + rename), per-namespace write queue; namespace must match `/^[a-z0-9._-]+$/` (else throws); corrupt file → renamed to `<ns>.json.corrupt-<timestamp>`, the namespace starts empty, and the plugin emits event `"storage.corrupt"` with `{ ns, backup }`.
- [ ] **Step 1: Failing tests:** `renderer acp proxies Sessions over a memory transport` (main kernel with acp main + fake agent, renderer kernel with acp renderer); `claude-code registers its agent with resolved script path`; storage: `set then get round-trips`, `concurrent sets to one ns serialize`, `corrupt file is backed up and starts empty`, `keys lists stored keys`.
- [ ] **Step 2–4:** run → FAIL, implement, run → PASS (≥95%). **Step 5: Commit** `feat(plugins): acp renderer, claude-code and storage`.

### Task 5: `app` and `layout-bare` plugins

**Files:** `plugins/app/**`, `plugins/layout-bare/**`, tests.

**Interfaces:**
- `app` (renderer): extension id `"app"` (root), inputs `{ providers: { multiple: true }, layout: {}, screens: { multiple: true }, overlays: { multiple: true } }`; value `{ component }` that wraps the layout in providers (outermost first by order) and renders overlays after it; provides `NavigationRef` (id `"app.navigation"`): `{ current(): string | undefined; go(screenId: string): void; subscribe(fn: () => void): () => void }` — default current = first screen id; exports `useCurrentScreen(): ResolvedNode | undefined`.
- `layout-bare`: extension attaches to `app/layout`, inputs `{ titlebar: {}, navigation: { multiple: true }, primary: {}, auxiliary: { multiple: true }, status: { multiple: true } }` (role contract, spec 6.1); renders only the current screen via `useCurrentScreen()` full-window.
- [ ] **Step 1: Failing tests:** `app renders layout inside providers in order`; `navigation defaults to first screen and go() switches`; `layout-bare renders only the current screen`; `app with no layout renders an inline Russian hint "Раскладка не установлена"`.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(plugins): app and layout-bare`.

### Task 6: `chat` plugin

**Files:** `plugins/chat/{src/renderer.tsx, src/timeline.tsx, src/items.tsx, src/api.ts}`, tests.

**Interfaces:**
- Screen extension attached to `app/screens` with `{ id: "chat", title: "Чат", component }`; inputs `{ composer: {} , inline: { multiple: true } }`.
- Provides `ChatSessionRef` (id `"chat.session"`): `{ snapshot(): SessionSnapshot | undefined; subscribe(fn): () => void; sessionId(): string | undefined }` for composer.
- Declares `RenderItemHook: HookRef<{ item: SessionItem }, ReactNode>` (mode `"sync"`, id `"chat.renderItem"`), default renderers per item kind; permission item shows option buttons calling `respondPermission`; error item shows message + collapsible stderr and a "Повторить" hint.
- Session flow: on mount `Sessions.ensure({ agentId: "claude-code", cwd: HostRef.projectDir })`, then loop `waitUpdates(sessionId, seq)`; loop stops on unmount; RPC errors show an error banner and retry with backoff (1 s, 2 s, 5 s max).
- Rendering: list keyed by item id; agent text as pre-wrapped plain text; auto-scroll to bottom unless the user scrolled up.
- [ ] **Step 1: Failing tests** (fake `Sessions` service provided in a test kernel): `ensure is called with claude-code and project dir`; `updates render items in order`; `permission buttons call respondPermission with optionId`; `error item shows stderr`; `RenderItemHook tap replaces item rendering`; `unmount stops polling`; Review Focus 4: `a 100k-character agent item renders in one element`.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(plugins): chat`.

### Task 7: `composer` plugin

**Files:** `plugins/composer/**`, tests.

**Interfaces:** attaches to `chat/composer`; `dependsOn: { chat, acp }`; textarea (`aria-label="Сообщение"`), Enter sends, Shift+Enter newline, buttons «Отправить» / «Стоп»; uses `ChatSessionRef` for busy state and `SessionsRef.prompt/cancel`; empty/whitespace text not sent; textarea cleared after successful send, kept on rejection with the error shown below.
- [ ] **Step 1: Failing tests:** `Enter sends trimmed text and clears`; `Shift+Enter inserts newline`; Review Focus 5: `while busy Send is replaced by Stop and Enter does not send`; `Stop calls cancel`; `rejected prompt keeps text and shows the error`.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(plugins): composer`.

### Task 8: `builds/minimal` and `apps/desktop`

**Files:** `builds/minimal/{package.json, loom.config.json}`; `apps/desktop/**`; `apps/desktop/e2e/{smoke.test.ts, stub-agent.mjs}`.

**Interfaces:**
- `builds/minimal/package.json`: `"loom": { "build": true, "plugins": ["@loom/plugin-storage", "@loom/plugin-acp", "@loom/plugin-claude-code", "@loom/plugin-app", "@loom/plugin-layout-bare", "@loom/plugin-chat", "@loom/plugin-composer"] }`; `loom.config.json` = `KernelConfig` (`{}` for now).
- `vite/loom-build.ts`: Vite plugin providing `virtual:loom/main-plugins` and `virtual:loom/renderer-plugins` — each exports `plugins: PluginDefinition[]` importing the `main`/`renderer` source entry (resolved from each plugin's package.json `loom` field; source path in dev, built path in prod) of every plugin in the build; plugins without that entry skipped.
- Main: `app.whenReady` → project dir = `LOOM_PROJECT_DIR` env, else the last used dir (`<userData>/last-project.json`), else `dialog.showOpenDialog({ properties: ["openDirectory"] })` (cancel → quit); `createKernel({ trust: () => true, hostServices: [[HostRef, { process: "main", projectDir, dataDir: app.getPath("userData"), endpoint }]] })`; reconcile with the build's main plugins + `loom.config.json`; `exposeServices(kernel, endpoint, [SessionsRef, AgentRegistryRef])`.
- Transport: main creates `MessageChannelMain`, sends port2 to the renderer via `webContents.postMessage("loom:port", null, [port])`; preload forwards it to the page with `window.postMessage(..., "*", [port])`; both sides wrap the port as kernel `Transport` (`apps/desktop/src/main/transport.ts`, `src/renderer/transport.ts`). Window close/reload → endpoint closes (bye) → main cancels running turns (Review Focus 2); `app.on("before-quit")` awaits `kernel.dispose()` (kills agents).
- Renderer: `createKernel({ trust: () => true, hostServices: [[HostRef, { process: "renderer", projectDir, dataDir: "", endpoint }]] })` (projectDir via `ipcRenderer.invoke("loom:project")` exposed by preload), reconcile with renderer plugins, `createRoot(...).render(<KernelProvider><RenderRoot/></KernelProvider>)`.
- `LOOM_AGENT_COMMAND` env var (test only): after reconcile, main re-registers agent id `claude-code` with `{ command: "node", args: [<path from env>] }` through `AgentRegistryRef.add` (later `add` with the same id replaces the earlier one — specify and test this in Task 3's registry).
- [ ] **Step 1: Failing smoke test** `apps/desktop/e2e/smoke.test.ts` (Playwright `_electron.launch` with `LOOM_PROJECT_DIR=<tmp>` to skip the dialog and `LOOM_AGENT_COMMAND="node e2e/stub-agent.mjs"`; stub-agent = ACP agent via SDK `AgentApp` that echoes the prompt as two chunks and requests one permission): window shows composer; typing «привет» + Enter shows the user item and the agent reply «эхо: привет» merged in one bubble; permission card appears and clicking «Разрешить» resolves it; closing the app leaves no stub-agent process.
- [ ] **Step 2: Run** `pnpm --filter @loom/desktop e2e` → FAIL. **Step 3: Implement.** `pnpm --filter @loom/desktop dev` must open the window for manual use. **Step 4: Run** → PASS. **Step 5: Commit** `feat(desktop): electron shell and minimal build`.

### Task 9: CI, docs

**Files:** `.github/workflows/ci.yml`, `README.md`, `docs/minimal-build.md`.
- [ ] **Step 1:** CI job `e2e` on `ubuntu-latest` (`xvfb-run pnpm --filter @loom/desktop e2e`) after `check`; existing jobs unchanged.
- [ ] **Step 2:** `docs/minimal-build.md` (Russian): how to run (`pnpm install`, `pnpm --filter @loom/desktop dev`), prerequisites (Claude Code login: `claude` once), what the build contains, how plugins are wired (build package → virtual modules), known limits (one session, no history).
- [ ] **Step 3:** `pnpm check && pnpm test:coverage && pnpm --filter @loom/desktop e2e` → green. **Commit** `docs: minimal build`, push, CI green.
