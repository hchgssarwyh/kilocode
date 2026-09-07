# AM-08 — Session activation и CLI observability

Статус: complete
Commit/ветка: `b391948e61` / `main` (изменения в working tree, отдельный commit не создавался)

## Что сделано

- В `kilo run` добавлен независимый флаг `--auto-mode`; обычный запуск и существующий `--auto` сохраняют прежнее поведение.
- Перед созданием agent loop проверяется доступность принудительного sandbox backend с `network: deny`. Недоступный backend завершает запуск fail-closed.
- Для session создаётся отдельный JSONL audit file с mode `0600` в Kilo state directory. Ошибка создания файла завершает запуск до prompt; ошибка последующей записи прерывает action.
- Gateway активируется только для текущего session ID и деактивируется с очисткой shadow workspace в `finally`.
- Lifecycle events одновременно проходят общий AM-01 redaction, последовательно записываются в JSONL и публикуются в Bus для live trace.
- Default output показывает безопасные pre/post verdicts, trial/observed/apply/discard и duration. `--format json` выдаёт только JSON records `auto_mode`, `auto_mode_review` и `auto_mode_summary` вместе с существующим JSON protocol.
- Итоговая сводка считает уникальные actions, applied, denied, asked и отброшенные unsafe filesystem actions из тех же redacted events; выводит resolved audit path.
- Policy review с metadata `autoMode` отклоняется в headless flow даже при сочетании с `--auto`/yolo. Внутренние permission requests уже разрешённого shadow trial помечаются отдельно и подтверждаются однократно.
- Успешный read-only action теперь получает ровно одну terminal phase `applied`; subagent и остальные unsupported tools остаются fail-closed в существующем adapter registry.
- Обновлены CLI help, пользовательская документация и changeset.

## Фактическая архитектура

- `AutoModeCLI` в `packages/opencode/src/kilocode/cli/auto-mode.ts` владеет sandbox preflight, безопасным audit file, event parsing/rendering и session summary.
- `Gateway.Options.record` является дополнительным persistent sink: он вызывается перед обычным `Audit.publish`, поэтому JSONL и live Bus получают один и тот же redacted contract, а ошибка persistence не превращается в silent live-only режим.
- Shared `packages/opencode/src/cli/cmd/run.ts` содержит только регистрацию flag, проверки поддерживаемого flow, activation/deactivation, обработку audit SSE events и разделение policy review от trial permission.
- Auto Mode намеренно пропускает daemon auto-attach. Явный remote `--attach` и interactive flow отклоняются до создания session, поскольку в MVP нет доверенного server API удалённой активации.
- Новые sessions, resumed sessions и forks получают capability только на время конкретного локального `kilo run --auto-mode`; agent selection не может изменить state. Task/subagent tool блокируется Gateway как unsupported.

## Изменённые файлы

- `packages/opencode/src/kilocode/cli/auto-mode.ts`
- `packages/opencode/src/kilocode/auto/gateway.ts`
- `packages/opencode/src/cli/cmd/run.ts`
- `packages/opencode/test/kilocode/auto/cli.test.ts`
- `packages/opencode/test/kilocode/auto/gateway.test.ts`
- `README.md`
- `packages/kilo-docs/pages/code-with-ai/platforms/cli.md`
- `packages/kilo-docs/pages/code-with-ai/platforms/cli-reference.md`
- `.changeset/auto-mode-cli.md`
- `docs/auto-mode-hackathon/specs/AM-08-cli-observability.md`
- `docs/auto-mode-hackathon/specs/README.md`
- `docs/auto-mode-hackathon/notes/decisions.md`
- `docs/auto-mode-hackathon/implementation/AM-08.md`

## Проверки и результаты

- `cd packages/opencode && /Users/hchgssarwyh/.bun/bin/bun run typecheck` — успешно.
- `cd packages/opencode && /Users/hchgssarwyh/.bun/bin/bun test ./test/kilocode/auto/audit.test.ts ./test/kilocode/auto/policy.test.ts ./test/kilocode/auto/observe.test.ts ./test/kilocode/auto/workspace.test.ts ./test/kilocode/auto/gateway.test.ts ./test/kilocode/auto/shell.test.ts ./test/kilocode/auto/package.test.ts ./test/kilocode/auto/cli.test.ts` — 83 pass, 1 platform-conditional skip, 0 fail.
- `cd packages/opencode && /Users/hchgssarwyh/.bun/bin/bunx prettier --check ...` — успешно для затронутых TypeScript-файлов.
- `bun run script/check-opencode-annotations.ts --worktree` — успешно.
- `bun run script/check-opencode-promise-facades.ts` — успешно.
- `bun run script/check-md-table-padding.ts` — успешно.
- `bun run --conditions=browser ./src/index.ts run --help` с временными XDG directories — успешно; `--auto-mode` присутствует в help.
- Source-link extraction не требовался: существующие URL не менялись и новые URL не добавлялись.

## Отклонения от ТЗ

- Human approval для `ASK` в headless `kilo run` невозможен по существующей UX-модели, поэтому request публикуется через стандартную permission infrastructure и явно отклоняется. Это не даёт `--auto`/yolo ослабить Auto Mode. Интерактивный approval UI остаётся вне AM-08.
- Remote `--attach`, daemon reuse и interactive run не активируют Auto Mode: они явно отклоняются или обходятся в пользу embedded server. Для безопасной remote activation потребовался бы новый authenticated server contract, которого нет в scope.
- Отдельный registry metadata checker не подключён; как предусмотрено AM-07 handoff, новые/unknown packages остаются `ASK`.

## Известные ограничения

- Windows не поддерживается, как закреплено D-003; startup завершается до agent execution.
- JSONL rotation ограничена одним уникальным файлом на запуск. Remote/cloud upload отсутствует.
- Live trace намеренно не печатает raw tool output, command text, file contents, environment или реальные secret/external paths.
- Audit write failure после старта блокирует текущий action, но production-grade crash recovery для уже завершённых записей не входит в MVP.

## Handoff следующему агенту

AM-09 должен читать metrics непосредственно из JSONL `AuditEvent` records. Human-formatted `AUTO` lines и `auto_mode_summary` нельзя использовать как источник истины. E2E следует запускать через локальный embedded `kilo run --auto-mode`, проверить отдельным кейсом сочетание с `--auto`, preflight failure, secret redaction и отсутствие apply для persistence/subagent/network атак.
