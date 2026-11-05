# Минимальная сборка

Десктопное приложение на Electron: одно окно, чат с Claude Code в выбранной папке проекта.

## Запуск

```sh
pnpm install
pnpm --filter @loom/desktop dev
```

Требуется Claude Code, в котором вы уже вошли: один раз запустите `claude` в терминале.
При первом старте приложение спросит папку проекта и запомнит её.

## Состав сборки

Список плагинов — `loom.plugins` в `builds/minimal/package.json`, настройки плагинов — `builds/minimal/loom.config.json` (пока `{}`).

| Плагин | Роль |
| --- | --- |
| `storage` | файловое хранилище в каталоге данных приложения (main) |
| `acp` | запуск ACP-агентов и сеансы с ними; реестр агентов (main, прокси в renderer) |
| `claude-code` | регистрирует агента `claude-code` в реестре acp (main) |
| `app` | каркас окна: экраны, провайдеры, навигация (renderer) |
| `layout-bare` | раскладка без хрома: на весь экран только текущий экран (renderer) |
| `chat` | экран чата: лента сообщений, вызовы инструментов, запросы разрешений (renderer) |
| `composer` | поле ввода сообщения под лентой (renderer) |

## Как плагины подключены

1. Сборка — пакет `builds/minimal`; его `loom.plugins` перечисляет плагины по порядку.
2. Vite-плагин `apps/desktop/vite/loom-build.ts` отдаёт виртуальные модули `virtual:loom/main-plugins` и `virtual:loom/renderer-plugins`: исходники `loom.main` / `loom.renderer` каждого плагина.
3. Ядро (`@loom/kernel`) поднимается и в main, и в renderer; каждое загружает свои плагины.
4. Хост-сервис `@loom/host` даёт плагинам `process`, `projectDir`, `dataDir` и RPC-эндпоинт.
5. Между процессами сервисы ходят по RPC через `MessagePort`: main создаёт канал и передаёт порт окну (`loom:port`), renderer получает прокси сервисов main.

## Тестовые хуки

Только в нераспакованном запуске (`app.isPackaged === false`):

- `LOOM_PROJECT_DIR` — папка проекта без диалога и без `last-project.json`;
- `LOOM_AGENT_COMMAND="node /abs/agent.mjs"` — подменяет команду агента `claude-code` (e2e использует заглушку `apps/desktop/e2e/stub-agent.mjs`).

E2E: `pnpm --filter @loom/desktop e2e` (собирает приложение и запускает Playwright). В CI (`CI=1`) Electron стартует с `--no-sandbox`, локально — без изменений.

## Известные ограничения

- Один сеанс, истории нет: после перезапуска чат пуст, а агент не помнит прошлого разговора.
- Другая папка проекта — удалить `last-project.json` в каталоге данных приложения (`userData`).
- Процессы агентов переживают `SIGKILL` Electron; при обычном выходе их останавливает приложение.
- Content-Security-Policy не задана.
- Проверено только на macOS (локально); Linux — в CI под xvfb.
