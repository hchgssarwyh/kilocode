# Текущая архитектура Kilo CLI

## Краткий вывод

Kilo CLI уже имеет почти все архитектурные швы, необходимые для прототипа Auto Mode:

- выбранный режим представлен объектом `Agent.Info`;
- доступные модели инструменты собираются централизованно;
- обычные builtin-tools проходят через единую обёртку `SessionTools.resolve`;
- каждый инструмент сам запрашивает разрешение через `Tool.Context.ask`;
- `Permission.Service` выдаёт `allow / ask / deny` по набору wildcard-правил;
- весь вызов инструмента может выполняться внутри существующего OS sandbox;
- до и после шага агента уже создаются Git-based snapshots, из которых строятся patch и undo.

При этом готового effect-based Auto Mode сейчас нет. Текущая система разрешений оценивает заявленный инструмент и его patterns, а sandbox ограничивает настоящее выполнение. Ни один существующий слой не выполняет действие в одноразовой копии и не принимает решение по полному наблюдённому diff до применения в рабочий проект.

## Стиль архитектуры

В коде мало классических классов с бизнес-логикой. Основной паттерн — Effect services и namespace-модули:

| Компонент | Основной тип/сервис | Файл |
|---|---|---|
| Режимы/агенты | `Agent.Service`, `Agent.Info` | `packages/opencode/src/agent/agent.ts` |
| Входной prompt и цикл | `SessionPrompt.Service` | `packages/opencode/src/session/prompt.ts` |
| Модельный runtime | `LLM.Service` | `packages/opencode/src/session/llm.ts` |
| Обработка stream-событий | `SessionProcessor.Service` | `packages/opencode/src/session/processor.ts` |
| Каталог инструментов | `ToolRegistry.Service` | `packages/opencode/src/tool/registry.ts` |
| Адаптер tools для модели | `SessionTools.resolve` | `packages/opencode/src/session/tools.ts` |
| Разрешения | `Permission.Service` | `packages/opencode/src/permission/index.ts` |
| Снимки workspace | `Snapshot.Service` | `packages/opencode/src/snapshot/index.ts` |
| Политика sandbox сессии | функции `SandboxPolicy.*` | `packages/opencode/src/kilocode/sandbox/policy.ts` |
| OS sandbox runtime | `CurrentProfile`, `run`, backend | `packages/kilo-sandbox/src/` |

Сервисы собираются через Effect layers. Состояние многих сервисов создаётся через `InstanceState` и ключуется текущей директорией проекта. `SandboxPolicy` дополнительно держит process-local maps, ключуя снимок политики парой `directory + sessionID`, и сохраняет authoritative state на диск.

## Путь одного пользовательского запроса

Упрощённый путь:

```text
CLI/TUI или kilo run
  → HTTP/session prompt API
  → SessionPrompt.Service
  → выбранный Agent.Info + model
  → ToolRegistry.Service.tools(...)
  → SessionTools.resolve(...)
  → LLM.Service
  → AI SDK или opt-in native runtime
  → модель выдаёт tool call
  → AITool.execute из SessionTools.resolve
  → plugin hook tool.execute.before
  → SandboxPolicy.executeTool
  → Tool.Def.execute(args, Tool.Context)
  → Tool.Context.ask → KiloSessionPrompt.askPermission
  → Permission.Service.ask
  → реальное действие
  → plugin hook tool.execute.after
  → tool result в SessionProcessor
```

Оба LLM runtime сходятся в одном `LLMEvent` stream. Поэтому защитный слой ниже `SessionTools.resolve` не должен зависеть от AI SDK или native runtime.

## Где формируется набор инструментов

`ToolRegistry.Service.tools` в `packages/opencode/src/tool/registry.ts`:

1. Берёт builtin, Kilo-specific и plugin tools.
2. Фильтрует их по клиенту, feature flags, модели и доступности.
3. Выбирает между `edit` и `apply_patch` в зависимости от модели.
4. Дополняет descriptions.
5. Возвращает `Tool.Def[]`.

`SessionTools.resolve` преобразует каждый `Tool.Def` в AI SDK tool. Именно здесь есть наиболее полный общий wrapper для обычных инструментов: before-hook, sandbox wrapper, собственное `execute`, after-hook и нормализация результата.

MCP tools добавляются в этом же модуле отдельной веткой. Их выполнение обёрнуто через `SandboxPolicy.executeMcp`. При ограниченной сети MCP tools и typed MCP resources скрываются или блокируются.

## Где реально исполняется действие

Инструмент описан интерфейсом `Tool.Def` из `packages/opencode/src/tool/tool.ts`:

```text
id
description
parameters / jsonSchema
execute(args, ctx) → Effect<ExecuteResult>
```

`Tool.Context` несёт `sessionID`, `messageID`, `callID`, agent, abort signal, сообщения, metadata callback и `ask`. Инструменты вызывают `ctx.ask(...)` непосредственно перед опасной операцией.

Примеры:

- `EditTool`, `WriteTool` и `ApplyPatchTool` сначала вычисляют diff/patterns, вызывают `ctx.ask({ permission: "edit", ... })`, затем пишут файл.
- `ShellTool` разбирает команду, строит command patterns и external-directory patterns, запрашивает `bash`/`external_directory`, затем запускает процесс.
- `ReadTool` запрашивает `read` и при необходимости `external_directory`.
- `WebFetchTool` запрашивает `webfetch`.
- `TaskTool` запрашивает разрешение на выбранного subagent и создаёт дочернюю сессию.

Это означает, что текущая точка контроля распределена на два уровня:

- общий execution wrapper находится в `SessionTools.resolve`;
- семантика конкретного разрешения и patterns находится внутри реализации каждого tool.

Для полноты Auto Mode одного изменения shell tool недостаточно: edit/write/apply_patch, MCP, plugin/custom tools и косвенные инструменты также должны попасть в модель эффектов.

## Snapshot вокруг шага

`SessionProcessor.Service.create` вызывает `Snapshot.track` до старта LLM stream. На `step-finish` создаётся новый snapshot, а `Snapshot.patch` фиксирует список изменённых файлов относительно начального hash. Patch сохраняется как part сообщения и используется для undo/redo.

Это уже даёт pre/post состояние на уровне шага модели, но не на уровне отдельного tool call. Несколько параллельных или последовательных tool calls одного шага могут попасть в один общий diff.

## Основные границы для Auto Mode

Подтверждённые общие швы:

1. `SessionTools.resolve` — обязательная обёртка обычных builtin tools и отдельная ветка MCP.
2. `Tool.Context.ask` — место, где инструмент уже сформировал permission, patterns и часть metadata.
3. `Permission.Service.ask` — централизованный `ALLOW / ASK / DENY` evaluator.
4. `SandboxPolicy.executeTool` — граница исполнения с OS confinement.
5. `Snapshot.Service` — существующие capture/diff/restore primitives для файлов workspace.

Главный архитектурный риск — plugin hooks выполняются снаружи `SandboxPolicy.executeTool`: `tool.execute.before` вызывается до входа в sandbox, `tool.execute.after` — после выхода. Защитный gateway должен явно решить, являются ли hooks доверенной частью хоста или потенциальным путём обхода.

