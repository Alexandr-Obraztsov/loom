# Loom

Настраиваемая IDE для ACP-агентов, в которой всё — плагин. Сейчас репозиторий содержит
ядро плагинов `@loom/kernel` и фасад для авторов плагинов `@loom/sdk`.

**Статус:** этап ядра завершён — плагины и зависимости, живые сервисы, хуки, события,
дерево расширений с переиспользованием узлов, live-reconcile с откатом, RPC между
процессами, загрузчик плагинов с диска. Есть минимальная сборка: Electron-оболочка с чатом к Claude Code.

- Ядро: [docs/kernel/README.md](docs/kernel/README.md) — понятия, коды ошибок, гарантии, производительность, ограничения
- Минимальная сборка (десктоп на Electron): [docs/minimal-build.md](docs/minimal-build.md) — запуск, состав, ограничения
- Спецификация: [docs/superpowers/specs/2026-11-04-loom-design.md](docs/superpowers/specs/2026-11-04-loom-design.md)

## Проверки

Нужны Node 22+ и pnpm.

```sh
pnpm install
pnpm check          # lint + lint-фикстуры + typecheck + dependency-cruiser + knip + api-extractor
pnpm test           # юнит-тесты kernel и sdk
pnpm test:coverage  # те же тесты с порогом покрытия 95% на пакет
pnpm test:perf      # ограничители производительности (без покрытия)
pnpm bench          # бенчмарки ядра (vitest bench)
```

CI (`.github/workflows/ci.yml`, Node 22 и 24) запускает `check`, `test:coverage` и `test:perf`; отдельная задача `e2e` гоняет Playwright-смоук десктопа под xvfb.

## Лицензия

MIT
