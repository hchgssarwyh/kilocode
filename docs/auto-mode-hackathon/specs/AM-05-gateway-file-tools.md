# AM-05 — Execution gateway и file tools

Статус: выполнено.

## Цель

Поставить единую обязательную границу вокруг builtin tool execution и провести через полный precheck → trial → observe → postcheck → apply/discard первые read/file tools.

## Зависимости

AM-01–AM-04 выполнены.

## Scope

- Kilo-owned `Gateway` с одним публичным execution API.
- Минимальный вызов gateway из общего `SessionTools` execution path.
- Адаптеры `read`, `glob`, `grep`, `edit`, `write`, `apply_patch`.
- Declared effects из tool name/args и существующего `ctx.ask`.
- Read-only fast path после precheck.
- Transaction path для mutations.
- Structured denial, пригодный для agent replan.
- Fail-closed registry для tools без адаптера.
- Audit lifecycle на всех exit paths.

Изменение shared OpenCode execution file должно быть минимальным и отмечено `kilocode_change`; основная логика располагается в `packages/opencode/src/kilocode/auto/`.

## Поведение mutation

1. Получить canonical action и declared effects.
2. Выполнить `Policy` precheck.
3. Захватить session mutex и checkpoint.
4. Выполнить исходный tool ровно один раз с directory, указывающей на shadow.
5. Получить observed effects.
6. Выполнить postcheck.
7. При `ALLOW` применить только проверенный change set в original.
8. При `ASK` дождаться существующего permission UX и apply/discard по ответу.
9. При `DENY` discard и вернуть безопасную structured error агенту.

## Security invariants

- В Auto Mode нет пути `tool.execute`, обходящего Gateway.
- Неизвестный mutating tool не исполняется.
- Tool result не возвращается как success до успешного apply.
- Denial не содержит file contents или непроверенный tool output.
- Hard permission denials существующих agent modes нельзя ослабить Auto Mode.
- Auto Mode не превращается в blanket permission auto-approve.

## Не входит в scope

- Shell execution.
- Package/network adapters.
- Пользовательский CLI-флаг; тесты включают state программно.
- MCP/plugin tools: они должны блокироваться как unsupported.

## Предполагаемые файлы

- `packages/opencode/src/kilocode/auto/gateway.ts`
- `packages/opencode/src/kilocode/auto/adapter.ts`
- `packages/opencode/src/kilocode/auto/tools/file.ts`
- минимальное изменение существующего `packages/opencode/src/session/tools.ts`
- `packages/opencode/test/kilocode/auto/gateway.test.ts`

## DoD

- E2E-level test выполняет safe `write` в shadow, проверяет original-before-verdict и immediate apply-after-verdict.
- Попытка создать `.vscode/tasks.json` не меняет original и возвращает `AUTO_PERSISTENCE_PATH`.
- `read/glob/grep` работают без workspace transaction, но оставляют precheck audit event.
- Каждый зарегистрированный builtin tool классифицирован как supported read/mutation либо explicit unsupported.
- Тест доказывает fail-closed неизвестного tool.
- Hard deny режима `plan` остаётся hard deny.
- Typecheck, targeted tests и annotation check проходят; создан `implementation/AM-05.md`.

## Handoff

AM-06 добавляет shell adapter через тот же Gateway; отдельный shell bypass запрещён.
