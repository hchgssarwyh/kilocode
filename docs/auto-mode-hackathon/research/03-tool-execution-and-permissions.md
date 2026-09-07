# Tool execution и permissions

## Текущий execution pipeline

Для builtin tool фактическая последовательность следующая:

```text
ToolRegistry.Service.tools
  → SessionTools.resolve создаёт AI SDK tool
  → model tool call
  → plugin: tool.execute.before
  → SandboxPolicy.executeTool(sessionID, tool, effect)
  → Tool.Def.execute(args, ctx)
  → один или несколько ctx.ask(...)
  → KiloSessionPrompt.askPermission
  → Permission.Service.ask
  → действие через FS/HTTP/process services
  → plugin: tool.execute.after
  → SessionProcessor получает tool-result/tool-error
```

`SessionTools.resolve` работает и для AI SDK, и для opt-in native LLM runtime: оба получают исполняемые tool definitions из одного подготовленного набора.

## Модель правил

Rule содержит:

```text
permission: string
pattern: string
action: allow | ask | deny
```

Основной evaluator — `Permission.evaluate` в `packages/opencode/src/permission/index.ts`. Он разворачивает объединённые rulesets и выбирает последнее правило, у которого wildcard совпал и с permission, и с pattern. Если совпадения нет, результат по умолчанию — `ask`.

Следствие: порядок merge является частью security semantics. Более позднее правило сильнее раннего, кроме дополнительного hardening в `Permission.resolve`.

## `Permission.resolve`

`resolve` отдельно вычисляет:

- base rule из agent/session ruleset;
- saved override из ранее одобренных и session-local правил.

Затем применяет Kilo hardening для read и Agent Manager. Base deny нельзя отменить сохранённым allow. Base ask можно снять только совместимым saved allow. Для `external_directory` используется отдельный evaluator.

`hardRuleset` проверяется как veto. Он нужен для `ask`/`plan`/`architect`, чтобы auto-approve и сохранённые wildcard rules не расширили защищённый режим.

## Поведение `Permission.Service.ask`

Для каждого pattern:

1. Вычисляется winning rule.
2. Hard deny или обычный deny немедленно возвращает `PermissionDeniedError`.
3. `allow` пропускает действие, кроме защищённых config paths.
4. `ask` создаёт pending request, публикует `permission.asked` и ждёт Deferred.

Ответы пользователя:

- `reject` завершает запрос ошибкой и отклоняет остальные pending asks той же session;
- `once` разрешает только текущий запрос;
- persistent approval добавляет allow rules и пишет их в global config.

`skillShell` и `sandboxEscalation` всегда требуют явного интерактивного ответа. Machine reply с allow игнорируется; reject допускается.

В plain headless run session помечается через `KiloHeadless`; unresolved `ASK` у subagent превращается в deny, чтобы процесс не завис навсегда.

## Какие patterns формируют инструменты

| Инструмент | Permission | Pattern/metadata |
|---|---|---|
| `edit`, `write`, `apply_patch` | `edit` | Пути относительно worktree; metadata содержит diff/filediff |
| `read` | `read` | Файл/URI; дополнительно external-directory для пути вне workspace |
| `shell` | `bash` | Разобранные tree-sitter подкоманды; отдельно external-directory globs |
| `webfetch` | `webfetch` | URL |
| `task` | `task` | Имя subagent |
| MCP resource reads | `read` | `mcp:<server>:<uri>` |
| MCP tools | permission с именем MCP tool | Обычно `*` или tool-specific metadata |

Shell parsing находится в `packages/opencode/src/tool/shell.ts`. Он использует tree-sitter для shell/PowerShell, собирает понятные command prefixes и директории. При активном sandbox потенциально мутирующая Git-команда дополнительно просит `sandbox_escalation`, потому что `.git` внутри sandbox read-only.

Важно: parser shell permissions — это не полноценный effect parser. Он преимущественно строит строки для wildcard permission rules и проверяет external paths. Он не создаёт универсальную структуру `read/write/network/package/persistence`.

## Tool visibility и permission evaluation — разные вещи

Полностью запрещённый wildcard tool может быть скрыт от модели через `Permission.visibleTools`, но большинство builtin tools остаются в каталоге и проверяют разрешение при вызове. Поэтому нельзя считать каталог tools security boundary.

Фильтрация нужна для UX и снижения ошибочных вызовов; authoritative решение находится в `ctx.ask`/`Permission.Service` и sandbox.

## MCP и plugin tools

- MCP tools собираются отдельно от builtin registry и вызываются через `SandboxPolicy.executeMcp`.
- При network-restricted sandbox MCP tools/resources недоступны, потому что вызов исполняется хостом и может иметь делегированные сетевые полномочия.
- Custom/plugin tools, которые не помечены builtin, получают fail-closed `assertNetwork` при ограниченной сети.
- Plugin hooks `tool.execute.before/after` находятся вне sandboxed effect.

Для Auto Mode требуется явно определить доверенную базу:

- считать установленные host plugins доверенными и оставить hooks за границей;
- либо переносить security-relevant hooks внутрь gateway;
- либо запрещать custom/plugin/MCP tools в hackathon-режиме.

Для демо третий вариант самый ограниченный и проверяемый, но это ещё не принятое решение.

## Естественная точка интеграции

`SessionTools.resolve` — наиболее полный общий seam для вызова. Однако policy должна получить данные, которые сейчас известны только конкретному tool в момент `ctx.ask`.

Поэтому вероятная форма интеграции состоит из двух частей:

1. Execution scope создаётся общим wrapper перед `Tool.Def.execute`.
2. Каждый `ctx.ask` не только получает permission verdict, но и регистрирует нормализованный declared effect в текущем scope.

После выполнения scope сможет сопоставить declared effects с observed effects. Это рабочая гипотеза, не готовое ТЗ.

