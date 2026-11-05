# Ядро Loom: чистка, читаемость, правила кода — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** удалить механизмы доверия, закрыть все отложенные проблемы ядра stage 1, сделать ядро читаемым как учебник и закрепить правила кода линтерами по всему репозиторию.

**Architecture:** сначала удаление доверия (меняет общие файлы), затем параллельная волна по непересекающимся модулям ядра (сервисы, хуки, мелкие модули, дерево, reconcile/runtime, RPC, загрузчик), затем пакеты и инфраструктура, затем новые правила линтера, затем проход документирования (комментарии, порядок чтения, AGENTS.md).

**Tech Stack:** TypeScript 5.9, Vitest 4 + fast-check, ESLint 10 flat + typescript-eslint 8, api-extractor, dependency-cruiser, knip, pnpm + Turborepo.

**Spec:** `docs/superpowers/specs/2026-11-05-loom-kernel-cleanup-design.md`

## Global Constraints

- Ветка `feat/kernel-cleanup` (от `feat/minimal-build`); ветки не переключать.
- Всё из `.superpowers/sdd/2026-11-04-loom-kernel/constraints.md`, кроме удаляемого доверия: core без Node built-ins/DOM/`electron`/`react`; runtime-зависимости ядра только `zod` и `semver`; strict TS + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax` + `isolatedDeclarations`; ESM; `max-lines` 300 / `max-lines-per-function` 80; без `any`; без default-экспортов кроме входных файлов плагинов; каждая ошибка — `LoomError` со стабильным `code` и `pluginIds`; транзакционный сериализованный `reconcile`.
- Покрытие ≥95% (statements, branches, functions, lines) для `packages/kernel` и `packages/sdk`.
- `pnpm test:perf` и бенчмарки ядра не хуже текущих.
- Поведение для плагинов меняется только по §4–§5 спеки; до 1.0 без слоя совместимости.
- Каждый пункт журнала stage 1 (`.superpowers/sdd/2026-11-04-loom-kernel/progress.md`: «minor (deferred)», «triage at final review», «Final: minor», 8 пунктов «Final review») и каждое «Известное ограничение» `docs/kernel/README.md` получает в отчёте задачи строку: `исправлено (тест)` / `контракт (где)` / `уже исправлено (коммит)` / `снято (причина)`. «Снято» — только если код удалён или исправление заметно дороже проблемы (оценка в отчёте).
- Коммиты заканчиваются трейлером `Co-Authored-By` модели, написавшей коммит.

## Review Focus

1. **Плагины репозитория после строгой схемы.** Любой плагин из `plugins/*` и `apps/desktop` (`turn-guard`) должен по-прежнему проходить `validatePlugin`; лишний ключ в чужом определении не должен молча ронять сборку → тест в Task 1 (все определения из `builds/minimal` валидны) и e2e в Task 9.
2. **Заморозка определений.** Плагин, который держит и меняет свои данные (конфиг, `defaults`, компоненты), не должен падать → тест в Task 4: мутация `defaults` расширения после `definePlugin` разрешена, мутация `extensions`/`dependsOn` бросает `TypeError`.
3. **Сервис, у которого настоящий метод `then`.** Прокси с провайдером обязан пробрасывать `then` реализации, а `undefined` возвращать только без провайдера → тест в Task 2.
4. **Перф горячих путей** после итеративного дерева и ленивых снимков событий → `pnpm test:perf` и `pnpm bench` в Task 3, 4, 5 (числа до/после в отчёте).
5. **Переименования ради порядка чтения** ломают пути: vitest-алиасы, depcruise, api-extractor entry, `exports` пакета, импорты тестов → Task 11 прогоняет `pnpm check`, `pnpm test:coverage`, e2e после переименования, до комментариев.

---

### Task 1: Удаление доверия и решения по поведению PluginsService

**Files:**
- Modify: `packages/kernel/src/core/kernel-runtime.ts` (опция `trust`, `trusted()`), `packages/kernel/src/core/plugins-service.ts` (`BeforeInstallHook`, `PLUGIN_UNKNOWN`, `reload` после `dispose`), `packages/kernel/src/core/errors.ts`, `packages/kernel/src/core/types.ts` (`scope`), `packages/kernel/src/core/manifest.ts` (`scope`, строгая схема), `packages/kernel/src/core/versions.ts` (`validRange("")`, `"v1.0.0"`), `packages/kernel/src/node/loader.ts` (штамповка scope), `packages/kernel/src/index.ts`, `packages/sdk/src/index.ts`, `apps/desktop/src/main/index.ts`, `apps/desktop/src/renderer/main.tsx`, `docs/kernel/README.md`, `docs/superpowers/specs/2026-11-04-loom-design.md`
- Test: `packages/kernel/test/core/{kernel,plugins-service,manifest,versions}.test.ts`, `packages/kernel/test/node/loader.test.ts`, новый `packages/kernel/test/core/manifest.repo.test.ts`

**Interfaces:**
- Produces: `LoomErrorCode` без `"UNTRUSTED"`, `"INSTALL_DENIED"`, с `"PLUGIN_UNKNOWN"`; `KernelOptions` без `trust`; `PluginDefinition` без `scope`; `PluginsService.enable/disable/uninstall(id)` для неизвестного id → reject `LoomError("PLUGIN_UNKNOWN", …, { pluginIds: [id] })` без прохода reconcile и без `plugins.changed`; `PluginsService.reload` после `kernel.dispose()` → reject `DISPOSED` (не синхронный throw); `validatePlugin` строгий.

- [ ] **Step 1: Failing tests** — `enable("nope")`/`disable("nope")`/`uninstall("nope")` → `PLUGIN_UNKNOWN`, слушатель `plugins.changed` не вызван; `reload()` после `dispose()` возвращает промис, который отклоняется `DISPOSED` (`expect(() => svc.reload("a")).not.toThrow()`); `validatePlugin({ id: "a", version: "1.0.0", dependOn: {} })` → `MANIFEST_INVALID`, `details.issues[0].path` = `["dependOn"]`; версия `"v1.0.0"` и диапазон `""` → `MANIFEST_INVALID`; `manifest.repo.test.ts`: каждое определение из `virtual`-списка сборки (импортировать входы `loom.main`/`loom.renderer` плагинов из `builds/minimal/package.json` и `createTurnGuard().plugin`) проходит `validatePlugin`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/core packages/kernel/test/node` → новые тесты FAIL по ожидаемым причинам.
- [ ] **Step 3: Удалить** `trust`, `trusted()`, `UNTRUSTED`, `scope` (тип, схема, загрузчик), `BeforeInstallHook`, `INSTALL_DENIED` и их тесты; убрать `trust: () => true` из десктопа и `BeforeInstallHook` из SDK; схема — `z.strictObject`; `versions.ts` отвергает префикс `v` и пустой диапазон; добавить `PLUGIN_UNKNOWN`.
- [ ] **Step 4: Доки** — удалить упоминания доверия/`scope`/`INSTALL_DENIED` из `docs/kernel/README.md` (таблица кодов: добавить `PLUGIN_UNKNOWN`) и из спеки `2026-11-04-loom-design.md`.
- [ ] **Step 5: Verify** `pnpm check && pnpm test:coverage` → зелёные; `git grep -nE "UNTRUSTED|INSTALL_DENIED|BeforeInstallHook|trust\??\(|scope\?: \"" -- packages apps plugins docs/kernel` → пусто; api-отчёт SDK обновлён (`pnpm --filter @loom/sdk api:update`).
- [ ] **Step 6: Commit** `refactor(kernel): drop trust, strict manifest, PLUGIN_UNKNOWN`

---

Tasks 2–8 идут параллельно после Task 1: их файлы не пересекаются. Каждая задача закрывает пункты журнала stage 1 своего модуля; список ниже — привязка пунктов к задаче, а решения по ним — в спеке §5.

### Task 2: Сервисы

**Files:** Modify `packages/kernel/src/core/services.ts`, `packages/kernel/src/core/service-helpers.ts`. Test `packages/kernel/test/core/services*.test.ts`.

**Пункты журнала:** Task 5 (нет ловушки `preventExtensions`, `getPrototypeOf` не пробрасывается; `then`/`toStringTag` без провайдера бросают; `onChange` без смены активной реализации; `states` не сжимается; четыре одинаковых `describe`; обёртка теряет `new`/`name`/`length`/статику; смена allowed-set только по идентичности; бросающий слушатель `onChange` оставляет регистрацию без remover), Task 14 (`registered` не чистится при снятии одиночной регистрации; нет регрессионного теста на обёртки методов per-proxy).

**Interfaces:** Produces — прокси без провайдера: `proxy.then === undefined`, `Object.prototype.toString.call(proxy) === "[object LoomService(<id>)]"`, прочие члены → `SERVICE_MISSING`; `onChange` вызывается только при смене активной реализации.

- [ ] **Step 1: Failing tests** — `await proxy` без провайдера резолвится в сам прокси, не бросает; с провайдером, у которого есть метод `then`, `proxy.then` — функция реализации (Review Focus 3); `onChange` не вызывается при `provide` второй реализации, не ставшей активной; `Object.freeze(proxy)` не бросает `TypeError` из-за `ownKeys`; бросающий слушатель `onChange` → `provide` возвращает remover, ошибка уходит в `onError`; после снятия всех регистраций ref `states.size`/`registered.size` возвращаются к исходным; обёртка класса-значения сохраняет `name`, `length`, статику и `new`; два потребителя одного сервиса получают разные обёртки с собственной атрибуцией.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/core/services` → FAIL.
- [ ] **Step 3: Implement** по пунктам; allowed-set — сравнение по содержимому (отсортированный ключ) вместо идентичности.
- [ ] **Step 4: Verify** `pnpm exec vitest run packages/kernel/test/core/services && pnpm test:perf` → PASS, перф прокси в пределах текущего порога (< 8×).
- [ ] **Step 5: Commit** `fix(kernel): service proxy and registry edge cases`

### Task 3: Хуки

**Files:** Modify `packages/kernel/src/core/hooks.ts`, `hook-order.ts`, `hook-run.ts`. Test `packages/kernel/test/core/hooks*.test.ts`, `registries.rank.test.ts`.

**Пункты журнала:** Task 6 (`report()` глотает исключения `onError`; `taps()` отдаёт внутренние объекты `Tap`; пробелы property-тестов; лишняя обёртка `rt.onError`; `refresh()` сообщает в `onError` до присвоения состояния; `arrange()` строит `byOwner` спредом O(n²); принятое отклонение «одно замыкание next на вызов» — оставить, закрепить комментарием), Task 10 (повторное сообщение о противоречивом ограничении после смены рангов — ключи по seq), ограничение «`run` в `setup` O(n² log n)».

**Interfaces:** Produces — `HookRegistry.taps(hook)` возвращает `readonly { owner: string; id?: string; priority: number }[]` (снимки, без `fn`); противоречие ограничений сообщается один раз на пару владельцев, пока оно существует, независимо от рангов.

- [ ] **Step 1: Failing tests** — мутация результата `taps()` не влияет на порядок; бросающий `onError` не теряет следующие отчёты и не ломает `run`; реентерабельный тап из `onError` во время `refresh()` попадает в порядок; противоречие не сообщается повторно после `reconcile`, меняющего ранги; упорядочивание 2000 тапов одного хука в `setup` (каждый плагин тапает и сразу `run`) укладывается в бюджет perf-теста (добавить в `perf.test.ts` кейс «run in setup», порог — 3× от времени батч-режима).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — ключ отброшенного ребра по паре `(owner, tapId)` вместо seq; `byOwner` через `Map` с push; инкрементальное упорядочивание при `run` в `setup` (пересчёт только хука, чьи тапы изменились). Если инкрементальность не укладывается в задачу — оставить, записать сложность в комментарий модуля и в отчёт как «контракт» (спека §5, **[строителю]**).
- [ ] **Step 4: Verify** `pnpm exec vitest run packages/kernel/test/core/hooks packages/kernel/test/core/registries.rank.test.ts && pnpm test:perf && pnpm --filter @loom/kernel bench` → PASS, числа в отчёте.
- [ ] **Step 5: Commit** `fix(kernel): hook ordering reports and snapshots`

### Task 4: Мелкие модули: события, disposables, ошибки, равенство, граф, определения

**Files:** Modify `packages/kernel/src/core/{events,disposables,errors,equal,graph,definitions}.ts`. Test соответствующие `packages/kernel/test/core/*.test.ts`, `events.compaction.test.ts`.

**Пункты журнала:** Task 2 (disposer, ждущий `store.dispose()` внутри своего запуска, — дедлок → закрепить JSDoc; guard `"details" in options` возможно мёртв; `details` всегда собственное свойство; бросающий `onError` в `runLate` вылетает из `add()`), Task 3 (`-0` и `0` хэшируются одинаково; Symbol по описанию; экземпляры классов по собственным ключам), Task 4 (приоритеты ошибок графа MANIFEST>MISSING / VERSION>CYCLE не протестированы; property-тесты без отсутствующих опциональных полей и циклов; лишние касты в `graph.ts`, локальная функция `describe`), Task 7 (нет тестов реентерабельного `emit`, не-Error из слушателя, удаления записи последнего слушателя; мёртвый `if (!list) return`; `details.type` не протестирован), ограничения «подписка O(n²)» и «определения неизменяемы».

**Interfaces:** Produces — `definePlugin(def)` возвращает определение с замороженной структурой (спека §5: сам объект, `dependsOn`, `optionalDependsOn`, `extensions` и их определения, `before`/`after`), значения внутри не замораживаются; `EventBus.on` — O(1) амортизированно.

- [ ] **Step 1: Failing tests** — `def.extensions.push(x)` и `def.dependsOn.x = "1"` бросают `TypeError`; `def.extensions[0].defaults.foo = 1` не бросает (Review Focus 2); `equal(-0, 0)` по принятой семантике (решение: `Object.is`, `-0 ≠ 0`); два разных `Symbol("a")` не равны; экземпляры разных классов с одинаковыми полями не равны; 4000 подписок одного типа < 5 мс (perf-кейс); `emit` во время `on`/`off` видит стабильный снимок; бросающий `onError` в `runLate` не вылетает из `add()`; приоритеты ошибок графа.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — события: список с версией, снимок копируется только если идёт `emit` (copy-on-write по флагу `emitting`); `equal`: `Object.is` для примитивов, сравнение прототипов для объектов.
- [ ] **Step 4: Verify** focused tests + `pnpm test:perf` + bench → PASS.
- [ ] **Step 5: Commit** `fix(kernel): events, disposables, equality and frozen definitions`

### Task 5: Дерево расширений

**Files:** Modify `packages/kernel/src/core/tree.ts`, `tree-index.ts`. Test `packages/kernel/test/core/tree*.test.ts`.

**Пункты журнала:** Task 8 (`reasonFor` кубический по глубине оторванной цепочки; рекурсия переполняется на ~3000; переиспользованный узел со сбоем схемы называет устаревший родительский плагин в `pluginIds`; тест «смена winners/disabled инвалидирует reuse» ничего не меняет; тест порядка ошибок одного уровня; сохраняется только первая ошибка узла (конфликт + переполнение входа); стабильно падающая фабрика пересобирает цепочку предков на каждой сборке), Task 10 (откат поднимает версии сервисов → no-op reconcile пересобирает узлы — часть в Task 6, здесь только переиспользование при неизменных версиях), ограничения «глубина 3000» и «квадратичные ошибки сирот».

**Interfaces:** Produces — `buildTree` итеративный; узел хранит все ошибки (`errors: readonly LoomError[]`), а не первую — если поле публично в `ResolvedNode`, отчёт SDK обновляется.

- [ ] **Step 1: Failing tests** — цепочка глубиной 10 000 строится без `RangeError`; оторванная цепочка 1000 → < 50 мс и одна ошибка на сироту с цепочкой, посчитанной один раз; конфликт + переполнение входа дают обе ошибки; стабильно падающая фабрика не меняет идентичность корня между двумя сборками без изменений; смена winners реально инвалидирует reuse (проверка идентичности узла).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — явный стек вместо рекурсии; мемоизация причины по узлу.
- [ ] **Step 4: Verify** focused tests + `pnpm test:perf` + bench (tree) → PASS, числа в отчёте.
- [ ] **Step 5: Commit** `fix(kernel): iterative tree, linear orphan errors`

### Task 6: Reconcile, runtime, контекст

**Files:** Modify `packages/kernel/src/core/{reconcile,kernel-runtime,kernel,context,plugins-service}.ts` (только то, что не тронул Task 1). Test `packages/kernel/test/core/{reconcile*,kernel*,context,plugins-service}.test.ts`.

**Пункты журнала:** Task 9 (dispose-тест не проверяет снятие override/decorate; `onDispose` не может использовать ctx — комментарий; тест «methods after dispose throw DISPOSED» не в той группе), Task 10 (поверхностный снимок `ctx.state` — контракт; откат поднимает версии сервисов → лишняя пересборка; плагин, ждущий PluginsService/dispose из `setup`, — дедлок очереди (документирован, не детектируется → детектировать: `LoomError("SETUP_FAILED", …, { details: { causeCode: "REENTRANT_RECONCILE" } })`); `disable` теряет `ctx.state` — контракт; `rank(plan.order)` посреди прохода поднимает версии ещё работающих удаляемых плагинов; `hooks.reorder` перестраивает безусловно), Task 14 (`disposeAll` закрывает батч хуков без `try/finally`), Final (`dispose()` после провала возвращает тот же отклонённый промис — контракт в JSDoc).

**Interfaces:** Produces — no-op `reconcile` после отката не меняет идентичность узлов дерева; вызов `PluginsService` из `setup` во время прохода отклоняется сразу, а не виснет.

- [ ] **Step 1: Failing tests** — откат, затем `reconcile` с тем же набором → корень дерева тот же объект; `setup`, ждущий `plugins.reload(...)`, → проход завершается `SETUP_FAILED` с `causeCode: "REENTRANT_RECONCILE"` за < 1 с; dispose снимает override и decorate; падающий teardown не оставляет батч хуков открытым; ранги удаляемых плагинов не меняются до их teardown.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — версии сервисов восстанавливаются при откате; реентерабельность — флаг «внутри прохода» + проверка владельца вызова.
- [ ] **Step 4: Verify** focused tests + `pnpm test:coverage` → PASS.
- [ ] **Step 5: Commit** `fix(kernel): reconcile rollback identity, reentrancy, dispose`

### Task 7: RPC

**Files:** Modify `packages/kernel/src/rpc/*.ts`. Test `packages/kernel/test/rpc/*.test.ts`.

**Пункты журнала:** Task 11 (прокси `remoteServicesPlugin` нельзя отменить и нет таймаута; `HOOK_TIMEOUT` покрывает и downstream — комментарий; `then` недостижим через прокси — документировать; дубликат `tapId` от пира оставляет локальный тап до close; нет теста позднего tap-result после таймаута; голый endpoint без приёмника молча теряет битые сообщения → `queueMicrotask` rethrow; двойные отчёты при нескольких приёмниках; недостижимый no-op `off`; `Transport.onMessage` типизирован `RpcMessage` вместо `unknown`; перенос JSDoc), Final (fallback-путь `sendOutcome` не протестирован; ярлыки R13/R14 в названиях тестов; отправка cancel в abort-обработчике не защищена), R19 (отмена для прокси и удалённых тапов).

**Interfaces:** Produces — сигнатуры сервисов не меняются; `RemoteServicesOptions.callTimeoutMs?: number` (по умолчанию нет таймаута) и отмена всех висящих вызовов при `endpoint.close()`; `Transport.onMessage(handler: (message: unknown) => void)`.

- [ ] **Step 1: Failing tests** — дубликат `tapId` заменяет прежний тап (один локальный тап); поздний tap-result после таймаута игнорируется без ошибки; битое сообщение на endpoint без приёмника → необработанная ошибка в микрозадаче (`process.on("uncaughtException")` в тесте); `callTimeoutMs: 50` → вызов отклоняется `RPC_CANCELLED` через ~50 мс, пир получает cancel; бросающий `transport.send` в abort-обработчике не даёт unhandled rejection; fallback `sendOutcome` для несериализуемого результата.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** по пунктам.
- [ ] **Step 4: Verify** `pnpm exec vitest run packages/kernel/test/rpc` → PASS; e2e десктопа не нужен (контракт транспорта тот же).
- [ ] **Step 5: Commit** `fix(kernel): rpc timeouts, duplicate taps, protocol errors`

### Task 8: Загрузчик

**Files:** Modify `packages/kernel/src/node/loader.ts`. Test `packages/kernel/test/node/loader.test.ts`.

**Пункты журнала:** Task 12 (ложное срабатывание проверки выхода за пределы на записях с префиксом `..`; лексическая проверка — комментарий «защита от опечаток»; default-экспорт Promise даёт путаную ошибку; `cacheBust` версионирует только входной файл — комментарий; пустая строка-вход молча пропускается; пустые строки), Task 12-2 (`validate()` кастует ошибку и читает `details.issues` без проверки; symlink-тесты без guard win32/EPERM; один пакет, слинкованный дважды, грузится дважды).

- [ ] **Step 1: Failing tests** — вход `"..hidden/main.js"` внутри пакета принимается; `"../x.js"` отвергается; default-экспорт Promise → `MANIFEST_INVALID` с текстом «default export is a Promise; export the plugin definition itself»; пустая строка-вход → `MANIFEST_INVALID`; один пакет по двум путям-симлинкам загружается один раз (по `realpath`).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** по пунктам; symlink-тесты пропускаются на win32 и при EPERM (`it.skipIf`).
- [ ] **Step 4: Verify** `pnpm exec vitest run packages/kernel/test/node` → PASS.
- [ ] **Step 5: Commit** `fix(kernel): loader entry checks and dedupe`

---

### Task 9: Пакеты и инфраструктура

**Files:** Delete `packages/host/**`; Modify `packages/sdk/src/index.ts` (+ новый `packages/sdk/src/host.ts`), `packages/sdk/package.json`, `packages/kernel/src/index.ts`, `packages/kernel/package.json` (+ `api-extractor.json`, `etc/kernel.api.md`), `plugins/{acp,chat,storage}/{package.json,src/**}`, `apps/desktop/{package.json,src/**}`, `vitest.config.ts`, `package.json`, `.dependency-cruiser.cjs`, `eslint.config.js`, `knip.json`, `tools/lint-fixtures/**`, `turbo.json`.

**Пункты журнала:** Task 1 (depcruise грузит только tsconfig ядра; knip глобально игнорирует semver/zod/@types/semver; запрет `@loom/sdk` только в блоке core; нет фикстур для node→rpc, node→entry, test-элементов; граница sdk→kernel держится на TS-резолвере), Task 12 (в core нет `no-restricted-globals` для `process`/`Buffer`), Task 13 (шум `turbo.json`; api-extractor на TS 6.0.3 против 5.9.3 — закрепить версию), Task 14 (`test`/`test:coverage` перечисляют проекты — исключать perf вместо перечисления; проверить, что так уже сделано).

**Interfaces:** Produces — `import { HostRef, type Host } from "@loom/sdk"`; `@loom/kernel` больше не экспортирует `createServiceRegistry`, `createHookRegistry`, `createEventBus`, `buildTree`, `createPluginContext`, `resolveOrder`, `dependentsOf`, `validatePlugin` и их типы (`ServiceRegistry`, `HookRegistry`, `EventBus`, `TreeConfig`, `TreeResult`, `ResolvedOrder`, `PluginContextArgs`, `ScopedPluginContext`); `pnpm --filter @loom/kernel api:check` существует и входит в `pnpm check`.

- [ ] **Step 1: Перенести** `HostRef`/`Host` в `packages/sdk/src/host.ts`, экспорт из SDK; удалить `packages/host`; перевести импорты и `package.json` плагинов и десктопа; убрать алиас `@loom/host` из `vitest.config.ts` и проект `host` (тесты перенести в `packages/sdk/test/host.test.ts`).
- [ ] **Step 2: Сузить** экспорты `packages/kernel/src/index.ts` по списку выше (тесты импортируют из `src/core/...`); добавить api-extractor для ядра, `api:check`/`api:update`, сгенерировать `etc/kernel.api.md`; закрепить версию `@microsoft/api-extractor` на совместимой с TS 5.9 (или `typescript` override для неё), записать решение в отчёт.
- [ ] **Step 3: Инфраструктура** — depcruise на корневой tsconfig; knip без глобальных игноров ядра; запрет `@loom/sdk` в блоках rpc и node; `no-restricted-globals` (`process`, `Buffer`) в core и rpc; фикстуры `tools/lint-fixtures` для node→rpc, node→entry, test-элементов, sdk→kernel-internal.
- [ ] **Step 4: Verify** `pnpm install && pnpm check && pnpm test:coverage && pnpm --filter @loom/desktop e2e` → зелёные; `git grep -n "@loom/host"` → пусто (кроме журналов `.superpowers`).
- [ ] **Step 5: Commit** `refactor: fold host into sdk, narrow kernel api, tighten tooling`

### Task 10: Правила линтера читаемости

**Files:** Modify `eslint.config.js`, `eslint.rules.js`, `package.json` (devDependencies), `tools/lint-fixtures/**`, любые `src`/`test` файлы, нарушающие новые правила.

**Interfaces:** Consumes — структура пакетов после Task 9.

- [ ] **Step 1: Добавить** правила (спека §7): `sonarjs/cognitive-complexity: ["error", 15]`, `max-depth: ["error", 4]`, `max-params: ["error", 3]`, `@typescript-eslint/switch-exhaustiveness-check: "error"`, `@typescript-eslint/naming-convention` (булевы переменные/свойства/параметры с префиксом `is|has|can|should|was|did`, интерфейсы без `^I[A-Z]`), `simple-import-sort/imports` и `/exports`. Проверить peer-диапазоны плагинов ESLint на ESLint 10; несовместимые — `@eslint/compat` `fixupPluginRules`; совсем неработающее правило выпадает с причиной в отчёте.
- [ ] **Step 2: Фикстуры** — по одному нарушающему файлу на правило в `tools/lint-fixtures`, `pnpm lint:fixtures` доказывает срабатывание.
- [ ] **Step 3: Привести код** — `pnpm exec eslint . --fix` для сортировки, затем ручная переработка нарушений сложности/глубины/параметров (объекты опций по правилу «больше трёх позиционных»). `eslint-disable-next-line <правило> -- <причина>` — не больше 5 на репозиторий, каждый в отчёте.
- [ ] **Step 4: Verify** `pnpm check && pnpm test:coverage && pnpm test:perf && pnpm --filter @loom/desktop e2e` → зелёные; `git grep -c "eslint-disable" -- packages plugins apps` ≤ прежнего числа + 5.
- [ ] **Step 5: Commit** `chore(lint): readability rules across the repo`

### Task 11: Порядок чтения и документирование ядра и SDK

**Files:** Modify все `packages/kernel/src/**`, `packages/sdk/src/**` (и, при переименовании, тесты, `vitest.config.ts`, `.dependency-cruiser.cjs`, `api-extractor.json`, `exports`); Create `AGENTS.md`, `CLAUDE.md`, `packages/kernel/AGENTS.md`, `packages/kernel/src/README.md` (если порядок показывается так); Modify `packages/{kernel,sdk}/api-extractor.json`, `docs/kernel/README.md` (раздел «Известные ограничения»).

**Interfaces:** Consumes — финальные модули после Tasks 2–8.

- [ ] **Step 1: Порядок чтения** — сделать порядок файлов `src/core` видимым без IDE (способ — **[строителю]**, спека §6): понятия → определения → реестры (сервисы, хуки, события, дерево) → план и граф → reconcile → runtime → `createKernel`; затем `rpc`, затем `node`.
- [ ] **Step 2: Verify после переименований** `pnpm check && pnpm test:coverage && pnpm --filter @loom/desktop e2e` → зелёные (Review Focus 5). Commit `refactor(kernel): reading order`.
- [ ] **Step 3: Обзорные комментарии** — в начале каждого файла `packages/kernel/src/**`: роль, на что опирается, кто использует, инвариант «чего никогда не делает» (3–8 строк).
- [ ] **Step 4: JSDoc на каждом экспорте** ядра и SDK по правилам спеки §6 (1–2 фразы: обещание, гарантии, коды `LoomError`, побочные эффекты; без пересказа типов); внутренние — только неочевидное «почему». Включить `ae-undocumented: { logLevel: "error" }` в обоих `api-extractor.json`; `pnpm --filter @loom/kernel api:update && pnpm --filter @loom/sdk api:update`.
- [ ] **Step 5: Имена тестов** — без ярлыков ревью (`R13`, `R14` и т.п.), имя = поведение.
- [ ] **Step 6: AGENTS.md** — корневой: раздел «Код» (правила спеки §6 списком), команды (`pnpm check`, `test:coverage`, `test:perf`, e2e), где что лежит; `packages/kernel/AGENTS.md`: порядок чтения, инварианты ядра (из Global Constraints), как добавить код ошибки, как обновить api-отчёт; `CLAUDE.md` в корне — одна строка `@AGENTS.md`.
- [ ] **Step 7: Известные ограничения** — переписать раздел `docs/kernel/README.md` под факт после Tasks 2–8 (только то, что осталось контрактом).
- [ ] **Step 8: Verify** `pnpm check` (api-extractor без `ae-undocumented`) `&& pnpm test:coverage` → зелёные; `for f in packages/kernel/src/**/*.ts; do head -1 "$f"; done` — каждый начинается с `/**` или `//` обзора.
- [ ] **Step 9: Commit** `docs(kernel): reading order, file overviews, TSDoc, AGENTS.md`

### Task 12: JSDoc-правила и комментарии вне ядра

Может идти параллельно с Task 11 (файлы не пересекаются, кроме `eslint.config.js`, который трогает только эта задача).

**Files:** Modify `eslint.config.js`, `package.json` (devDependencies), `tools/lint-fixtures/**`, `packages/react/src/**`, `plugins/*/src/**`, `apps/desktop/src/**`.

- [ ] **Step 1: Правила** — `jsdoc/require-jsdoc` (`publicOnly: true`, `require: { FunctionDeclaration, ClassDeclaration, MethodDefinition, ArrowFunctionExpression }`, `contexts` для `TSInterfaceDeclaration`, `TSTypeAliasDeclaration`, экспортируемых `VariableDeclaration`), `jsdoc/require-description`, `jsdoc/no-types`, `tsdoc/syntax` — для `src` всех пакетов, плагинов и десктопа (ядро и SDK уже соответствуют после Task 11; если Task 11 ещё идёт — включить для них в последнем коммите после слияния). Фикстура на каждое правило.
- [ ] **Step 2: Комментарии** — 1–2 фразы на каждом экспорте `packages/react`, `plugins/*`, `apps/desktop` по правилам спеки §6.
- [ ] **Step 3: Verify** `pnpm check && pnpm test:coverage && pnpm --filter @loom/desktop e2e` → зелёные.
- [ ] **Step 4: Commit** `docs: TSDoc on every export, jsdoc lint rules`

---

## Итоговая проверка (контроллер)

- `pnpm check && pnpm test:coverage && pnpm test:perf && pnpm --filter @loom/desktop e2e`; CI зелёный после пуша.
- Сводная таблица всех пунктов журнала stage 1 и ограничений с итогом из отчётов задач — в `.superpowers/sdd/2026-11-05-loom-kernel-cleanup/progress.md`; пунктов без строки нет.
- Ревью всей ветки, PR `feat/kernel-cleanup` → `main` (после влития PR #2 — rebase или смена base).
