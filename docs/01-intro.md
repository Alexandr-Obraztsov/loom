# Loom — IDE для агентных воркфлоу (черновик-введение)

> **Устарело.** Актуальный документ: [superpowers/specs/2026-11-04-loom-design.md](superpowers/specs/2026-11-04-loom-design.md). Здесь — первоначальное видение, часть решений изменилась (ядро на ACP, всё — плагины, другая раскладка).

## Суть в одном абзаце

**Loom — локальное приложение, в котором задача разработчика проходит через
цепочку агентов, и каждый агент показывает свою работу в подходящем визуале,
а не только в чате.** Искатель контекста — дерево источников. Figma-агент —
живая песочница с диффом против макета. Проектировщик логики — схема
состояний. Чат с вызовами тулов есть у всех, но он второстепенен: человек
проверяет результат глазами за секунды, а не читает простыни сообщений.

Всё, кроме ядра, — плагины: агенты, тулы, отображения, воркфлоу, коннекторы.
Фронтендер, бэкендер и QA получают разные сборки одной платформы.

## Пример: фронтенд-задача

```
[Jira-тикет] → Context Hunter ──→ Logic Designer ──→ Figma Builder ──→ Reviewer
                 вид: дерево        вид: statechart    вид: песочница      вид: diff
                 Jira/Wiki/Time     ✋ апрув схемы      + pixel-score        ✋ апрув MR
```

`✋` — человеческий гейт: воркфлоу ждёт апрува, правку или откат на шаг.

---

## 1. Аналоги: что берём, что нет

| Решение | Что это | Берём | Не берём |
|---|---|---|---|
| **VS Code / Theia** | IDE с contribution points | Манифест плагина с точками расширения, ленивую активацию | Монолитный extension host без изоляции UI |
| **MCP + MCP Apps** (SEP-1865, янв. 2026) | Тулы + UI-ресурсы `ui://` в sandboxed iframe | Тулы = MCP-серверы; кастомные виды в iframe по postMessage/JSON-RPC — совместимость с чужими MCP Apps бесплатно | — |
| **AG-UI** (CopilotKit) | Событийный протокол агент↔UI: ~16 типов событий, state deltas, interrupts | Модель событий и state-delta (JSON Patch), interrupt для human-in-the-loop | Привязку к их SDK |
| **A2UI** (Google) | Декларативная спецификация UI-виджетов от агента | Идею «агент шлёт данные + тип, UI рисует сам» | Генерацию UI агентом как основной путь — нестабильно |
| **ACP** (Zed, JetBrains) | Протокол редактор↔агент; Claude Code, Codex, Gemini CLI через адаптеры | Подключение любых CLI-агентов как «движка» шага воркфлоу | — |
| **LangGraph / Mastra** | Графы агентов, чекпоинты | Граф с состоянием, чекпоинты, resume/replay | Python-центричность, их рантайм как обязательный |
| **Langflow / Flowise / n8n** | Визуальные no-code канвасы | Канвас редактирования воркфлоу | Канвас как основной UX: на 20–30 узлах захламляется |
| **Cate / 49Agents** | Infinite canvas с агентами и терминалами | Пространственную раскладку агентов | Отсутствие типизированных видов |
| **Grafana** | Панели-плагины поверх источников данных | **Разделение «данные ↔ панель»**: панель рендерит тип данных, а не конкретный источник | — |
| **Storybook** | Каталог компонентов | Встраиваем как вид для UI-агентов | — |

**Главный вывод:** ни одно решение не связывает *типизированный артефакт
агента* с *заменяемым отображением*. Это и есть ниша.

---

## 2. Архитектура

### Ключевая идея: агенты и виды не знают друг о друге

```
 Агент ──emit──▶  Artifact { type: "context.tree@1", data }  ◀──render── View
                  Event    { tool.call, text.delta, state.patch, interrupt }
```

Агент пишет **типизированные артефакты** в общий стор. Вид объявляет, какие
типы умеет рендерить. Связь — через реестр типов (как MIME). Поэтому:

- свой агент сразу получает существующие виды, если отдаёт известный тип;
- свой вид работает со всеми агентами, которые отдают этот тип;
- схема типа (zod / JSON Schema) — единственный контракт между ними.

### Слои

```
┌─────────────────────────────── Shell (Electron + React) ─────────────────────────────┐
│  Workbench: dock-панели · канвас воркфлоу · чат · вид агента · инспектор             │
│  View Host: trusted-виды (in-process React) | sandboxed-виды (iframe, MCP Apps)      │
└───────────────────────────────▲──────────────── WS: события + JSON Patch ────────────┘
┌───────────────────────────────┴──────────── Core daemon (Node/TS) ───────────────────┐
│  Workflow Engine   граф шагов, гейты, ретраи, event sourcing → resume/replay         │
│  Agent Runtime     Claude Agent SDK — по умолчанию; позже драйверы ACP (Codex,       │
│                    Gemini CLI) и HTTP (свои агенты на любом языке)                   │
│  Blackboard        стор артефактов и состояния воркфлоу (SQLite)                     │
│  Tool Broker       MCP-клиент: Jira, Wiki, Figma, Playwright, свои; политики доступа │
│  Plugin Registry   манифесты, типы артефактов, версии, права                         │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Ядро — отдельный процесс с WS/HTTP API: оболочку можно заменить на веб, а
воркфлоу запускать headless в CI.

### Точки расширения (манифест плагина)

```jsonc
// plugins/figma-builder/loom.plugin.json
{
  "id": "acme.figma-builder", "version": "0.1.0",
  "contributes": {
    "agents": [{
      "id": "figma-builder",
      "runtime": "claude-sdk",            // | "acp:codex" | "http"
      "skill": "./skills/pixel-perfect.md",
      "tools": ["mcp:figma", "mcp:playwright", "./tools/pixel-diff.ts"],
      "emits": ["ui.sandbox@1", "ui.diff@1"]
    }],
    "artifactTypes": [{ "id": "ui.diff@1", "schema": "./schemas/diff.json" }],
    "views": [{
      "id": "sandbox-view", "renders": ["ui.sandbox@1", "ui.diff@1"],
      "entry": "./views/sandbox/index.html", "isolation": "iframe"
    }],
    "workflows": ["./workflows/frontend-task.yaml"]
  }
}
```

| Тип плагина | Что задаёт | Пример |
|---|---|---|
| **Agent** | скилл, модель, рантайм, тулы, какие артефакты отдаёт | Context Hunter |
| **Tool** | MCP-сервер или TS-функция | `pixel-diff` |
| **Artifact type** | схема данных + версия | `context.tree@1` |
| **View** | рендер типов артефактов + действия пользователя | дерево источников |
| **Workflow** | граф шагов, гейты, маппинг артефактов между шагами | `frontend-task.yaml` |
| **Profile** | набор плагинов, раскладка, тема под профессию | «Frontend» |

### Воркфлоу

```yaml
# workflows/frontend-task.yaml
id: frontend-task
input: { ticket: jira.issue }
steps:
  context:  { agent: context-hunter, in: { ticket: $input.ticket } }
  logic:    { agent: logic-designer, in: { ctx: $context.out } , gate: approve }
  ui:       { agent: figma-builder,  in: { ctx: $context.out, spec: $logic.out },
              until: "$ui.out.diff.score >= 0.98", maxIterations: 8 }
  review:   { agent: reviewer, in: { all: $steps }, gate: approve }
```

- **Event sourcing**: каждое событие в лог → перемотка воркфлоу назад,
  «перезапусти с шага logic с моей правкой», реплей для отладки агентов.
- **Обратная связь из вида**: клик по узлу дерева «не то» → событие
  `user.feedback` уходит агенту как сообщение с привязкой к артефакту.

### Движок агентов: Claude Agent SDK (решено)

Агент-плагин Loom — тонкая обёртка над возможностями SDK, а не свой рантайм:

| Loom | Claude Agent SDK |
|---|---|
| `skill` агента | system prompt + Skills (`.claude/skills`) |
| `tools` | MCP-серверы (in-process `createSdkMcpServer` для TS-тулов) |
| вложенные помощники агента | subagents (`agents` в опциях `query`) |
| лента событий в чате | стрим сообщений SDK → нормализуем в события Loom |
| артефакты | тул `emit_artifact(type, data)`, который ядро регистрирует каждому агенту; данные валидируются схемой типа |
| гейты и политики тулов | `canUseTool` + hooks (`PreToolUse`/`PostToolUse`) |
| resume / перезапуск шага | сессии SDK (`resume`) + наш event log |

Слой драйвера остаётся интерфейсом (`AgentDriver`), чтобы позже добавить ACP
без переделки ядра, но MVP пишется только под SDK.

### Интерфейс: знакомый каркас + 5 слотов

Каркас повторяет агентские IDE (Cursor agents, Codex app, Claude Code desktop,
Zed): человек, открывший Loom впервые, уже знает, где что.

```
┌ ⌘K ──────────────────────────────────────────────────────────────┐
│ Задачи         │ Чат агента                │ Панель видов [tabs] │
│ ▾ FRONT-1423   │ ⌁ tool calls (свёрнуты)   │ Песочница│Storybook│ │
│   ● Context    │ ▦ артефакт → открыть вид  │ События│ +           │
│   ● Logic      │ ◆ гейт: Утвердить / Вернуть│                     │
│   ◉ Figma      │                           │  вид плагина        │
│   ◆ Reviewer   │ [composer: @ · model · ⛨] │                     │
└──────────────────────────────────────────────────────────────────┘
```

- **Шаги воркфлоу = вложенные треды** в сайдбаре, а не отдельный канвас.
  Канвас — только в редакторе воркфлоу.
- **Вид агента = вкладка правой панели**, как Diff/Browser в Claude Code.
  Вкладка «События» есть всегда — это сырой поток, общий для всех агентов.
- **Артефакт в чате — карточка**; клик открывает его вид в панели.
- **Гейт — карточка в чате** (как запрос разрешения), а не модалка.
- Цвет только для статуса; всё оформление — CSS-токены, тема их переопределяет.

UI расширяется ровно через пять слотов — меньше слотов, проще писать плагины:

| Слот | Где | Пример |
|---|---|---|
| `pane` | вкладка правой панели, рендерит типы артефактов | дерево контекста, песочница |
| `inline` | карточка артефакта в чате (превью) | мини-score пиксель-диффа |
| `composer` | кнопка / `@`-источник / `/`-команда в поле ввода | `@jira`, `/rerun` |
| `command` | команда в ⌘K | «Перезапустить шаг с правкой» |
| `theme` | набор токенов | тёмная, компактная |

Сайдбар, чат и раскладка не расширяются — это каркас, его стабильность и
есть «похоже на другие IDE».

### Изоляция и безопасность

- Чужие виды — только iframe с deny-by-default CSP, доступ к ядру через
  postMessage + права из манифеста.
- Тулы с побочными эффектами (запись в Jira, git push) — через политику
  «спросить / разрешить / запретить» на уровне профиля.

---

## 3. Стек

| Слой | Выбор | Почему |
|---|---|---|
| Оболочка | **Electron** | `WebContentsView` для песочниц и Storybook, Node рядом, Playwright без мостов. Tauri легче, но встраивать чужие dev-серверы и CDP сложнее |
| UI | **React 19 + Vite + TypeScript** | экосистема видов; сторонние разработчики пишут на привычном |
| Анимации | **Motion** (framer-motion) + View Transitions API | layout-анимации панелей, spring-переходы между шагами |
| Компоненты | **Radix + Tailwind** (shadcn-подход) | кастомизируемая база, темы через CSS-переменные |
| Раскладка | **dockview** | dock-панели как в IDE, сохраняемые лэйауты профиля |
| Графы / схемы | **React Flow (xyflow) + ELK** | канвас воркфлоу, statechart, дерево контекста |
| Стейт UI | **Zustand** + JSON Patch из ядра | артефакты стримятся патчами |
| Ядро | **Node 22 / TypeScript**, Fastify + WS | один язык с плагинами |
| Агенты | **Claude Agent SDK** (TS) | skills, subagents, MCP, hooks, сессии из коробки; ACP — позже |
| Тулы | **MCP** (TS SDK), Figma Dev Mode MCP, Playwright MCP | стандарт, готовые серверы |
| Хранилище | **SQLite** (better-sqlite3 + Drizzle) | локально, event log + артефакты |
| Схемы | **zod** → JSON Schema | контракты артефактов и манифестов |
| Pixel-perfect | Playwright screenshots + **pixelmatch** / SSIM | метрика для цикла `until` |
| Монорепо | **pnpm workspaces + Turborepo** | core / shell / sdk / plugins |

---

## 4. Что дальше уточнить

1. **Кто первый пользователь** — ты сам на своих задачах или команда? От этого
   зависит, делать ли сначала профили и маркетплейс или один сильный воркфлоу.
2. ~~Движок агентов~~ — **решено: Claude Agent SDK**.
3. **Первый вертикальный срез** — предлагаю `Context Hunter + дерево`:
   проверяет всю цепочку «агент → артефакт → вид → обратная связь» на одном
   агенте.

Источники: [AG-UI](https://docs.ag-ui.com/introduction.md),
[A2A/MCP/AG-UI/A2UI stack](https://medium.com/@visrow/a2a-mcp-ag-ui-a2ui-the-essential-2026-ai-agent-protocol-stack-ee0e65a672ef),
[MCP Apps](https://www.morphllm.com/mcp-apps),
[ACP (Zed)](https://zed.dev/acp), [Zed external agents](https://zed.dev/docs/ai/external-agents),
[Langflow review 2026](https://aiindigo.com/blog/langflow-review-2026-visual-orchestration-for-the-agentic-era),
[49Agents](https://www.hnshowcase.com/post/47942287/49agents-2d-canvas-ide-for-orchestrating-agents-repos-issues).
