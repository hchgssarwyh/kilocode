# AM-05 — Execution gateway и file tools

Статус: complete
Commit/ветка: `b391948e61` / `main` (изменения в working tree, отдельный commit не создавался)

## Что сделано

- Добавлен session-scoped `Gateway` с программными `activate`/`deactivate` и единым `execute` API для tool calls.
- Полный lifecycle file action проходит через precheck, shadow trial, observe, postcheck и immediate apply/discard; read-only tools используют fast path без Workspace transaction.
- Добавлены адаптеры `read`, `glob`, `grep`, `edit`, `write`, `apply_patch`; остальные известные builtin tools и любой неизвестный ID классифицируются как unsupported.
- Declared effects строятся из доверенного tool ID/args и дополняются при существующих `ctx.ask`; `apply_patch` различает add/update/delete/move.
- `SessionTools` вызывает Gateway до исполнения builtin/custom tool. Plugin before/after hooks поддерживаемого builtin входят в trial scope; custom tool не доходит до hook или собственного execute.
- MCP tools и typed MCP resource tools получают отдельный вызов того же Gateway до plugin hook и блокируются в активной Auto Mode session.
- Добавлена структурированная ошибка `Gateway.Denied` с action ID, фазой и стабильными rule codes без tool output или file contents.
- Agent-facing success result заменяет внутренний shadow path на original path; success возвращается только после `Workspace.apply`.
- Уточнён `Workspace.Transaction.discard`: Gateway передаёт observed effects и post-decision в terminal audit, а уже завершённый discard не порождает второе terminal `failed` событие.

## Фактическая архитектура

- `Adapter.resolve` в `packages/opencode/src/kilocode/auto/adapter.ts` является fail-closed registry. Только шесть tools AM-05 имеют kind `read`/`mutation`; явные будущие группы AM-06/AM-07 и прочие builtin IDs имеют kind `unsupported`, неизвестный ID получает тот же результат.
- `Gateway.activate` сохраняет доверенные session ID/root/audit options. Shadow создаётся лениво при первом mutation и переиспользуется до `Gateway.deactivate`.
- `Gateway.execute` ничего не меняет для неактивной session. В активной session он создаёт canonical `Action`, вызывает только публичный `Policy.evaluate`, публикует audit и сохраняет существующий `Tool.Context.ask` как обязательную permission boundary.
- Mutation callback получает переписанные absolute file args и `InstanceRef`/legacy instance context, указывающие на `tx.root`. Relative paths автоматически разрешаются file tools относительно shadow.
- Один и тот же audit sink используется Gateway и Workspace. По умолчанию sink вызывает общий `Audit.publish`; tests могут передать deterministic collecting sink.
- Изменение `packages/opencode/src/session/tools.ts` ограничено импортом, небольшим gateway hook и MCP gates с `kilocode_change` annotations; business logic остаётся в Kilo-owned paths.

## Изменённые файлы

- `packages/opencode/src/kilocode/auto/adapter.ts`
- `packages/opencode/src/kilocode/auto/gateway.ts`
- `packages/opencode/src/kilocode/auto/workspace.ts`
- `packages/opencode/src/session/tools.ts`
- `packages/opencode/test/kilocode/auto/gateway.test.ts`
- `docs/auto-mode-hackathon/specs/AM-05-gateway-file-tools.md`
- `docs/auto-mode-hackathon/specs/README.md`
- `docs/auto-mode-hackathon/implementation/AM-05-gateway-file-tools.md`

## Проверки и результаты

- `cd packages/opencode && /Users/hchgssarwyh/.bun/bin/bun test ./test/kilocode/auto/audit.test.ts ./test/kilocode/auto/policy.test.ts ./test/kilocode/auto/observe.test.ts ./test/kilocode/auto/workspace.test.ts ./test/kilocode/auto/gateway.test.ts` — 63 pass, 0 fail.
- `cd packages/opencode && /Users/hchgssarwyh/.bun/bin/bun run typecheck` — успешно.
- `cd packages/opencode && /Users/hchgssarwyh/.bun/bin/bunx prettier --check src/kilocode/auto/adapter.ts src/kilocode/auto/gateway.ts src/kilocode/auto/workspace.ts src/session/tools.ts test/kilocode/auto/gateway.test.ts` — успешно.
- `bun run script/check-opencode-annotations.ts --worktree` из корня — успешно.
- `bun run script/check-opencode-promise-facades.ts` из корня — успешно, runtime drift не найден.
- `bun run script/check-md-table-padding.ts` из корня — успешно, 402 Markdown-файла проверены.
- `git diff --check` — успешно.

Абсолютный путь к Bun использован потому, что binary не присутствует в `PATH` текущего shell.

## Отклонения от ТЗ

- Programmatic session activation реализована минимально внутри Gateway, чтобы AM-05 можно было включать тестами. CLI flag, sandbox support preflight, persistent state и пользовательский UX остаются в AM-08.
- Отчёт назван `AM-05-gateway-file-tools.md` по общему шаблону `AM-NN-<slug>.md`, хотя сокращённая строка DoD упоминает `implementation/AM-05.md`.

## Известные ограничения

- `Gateway.activate` должен вызываться доверенным host-кодом и обязательно сопровождаться `Gateway.deactivate`; автоматическое подключение к session lifecycle относится к AM-08.
- Policy `ASK` передаётся существующему `ctx.ask`. Принудительное требование именно интерактивного человека при сочетании с `--auto`/yolo должно быть закреплено активацией и permission UX в AM-08.
- Shell остаётся explicit unsupported и не исполняется в Auto Mode до AM-06. Package/network adapters не добавлялись.
- Host plugin hooks считаются частью доверенного CLI host. Для поддерживаемых builtin они вызываются внутри Gateway trial flow, но произвольный direct Node filesystem access самого host plugin не изолируется OS sandbox как отдельный процесс.
- Gateway заменяет известный shadow prefix в успешном structured result. Новые adapters с нестандартными binary/result containers должны явно сохранить этот invariant.

## Handoff следующему агенту

AM-06 должен добавить `bash` в существующий `Adapter.registry` как mutation только после консервативной shell-классификации и передать shell execution в тот же `Gateway.execute`; отдельный execution wrapper запрещён. Shell callback уже получает shadow `InstanceRef`, но AM-06 обязана дополнительно построить sandbox profile, физически исключающий write в original, запретить background/interactive forms и проверить network deny. Не менять activation/CLI UX до AM-08.
