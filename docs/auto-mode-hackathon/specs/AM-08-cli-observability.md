# AM-08 — Session activation и CLI observability

Статус: выполнено.

## Цель

Безопасно включить готовый контур в CLI и дать пользователю понятный live trace, persistent JSONL audit и итоговую сводку работы Auto Mode.

## Зависимости

AM-01–AM-07 выполнены и зелёные.

## Scope

- CLI flag `--auto-mode` для `kilo run`.
- Независимое session state; существующий `--auto` сохраняет прежнюю семантику.
- Проверка sandbox support до начала agent loop.
- Наследование Auto Mode только в разрешённых session flows; subagents в MVP блокируются.
- Live CLI rendering из audit Bus events.
- JSONL audit в Kilo-controlled state/log directory.
- Итоговая session summary и путь к audit file.
- Поддержка machine-readable run output без смешивания human trace с JSON protocol.
- Human `ASK` через существующую permission инфраструктуру без blanket approve.

## Live trace

Минимальный вид:

```text
AUTO  #a1 write src/auth.ts          pre ALLOW
AUTO  #a1 trial                      42 ms
AUTO  #a1 observed 1 file            post ALLOW
AUTO  #a1 applied 1 file             7 ms
AUTO  #a2 write .vscode/tasks.json   DENY AUTO_PERSISTENCE_PATH
```

Итог:

```text
Auto Mode: 6 actions, 4 applied, 1 denied, 1 asked
Protected: 1 unsafe filesystem action discarded
Audit: <resolved safe path>
```

Verbose/debug вариант может показывать safe relative paths и effect categories. По умолчанию не показываются raw stdout, file contents, env и secret-like paths.

## Security invariants

- Если platform sandbox unsupported или initialization не завершена, `--auto-mode` не стартует agent execution.
- `--auto-mode` не эквивалентен `--auto`/yolo и не отвечает `allow` на все permissions.
- События одной action упорядочены; terminal phase ровно одна.
- Невозможность записать audit file видна пользователю. Решение fail-closed/continue-with-live-only должно быть явным и протестированным; для демо предпочтителен fail-closed при старте.
- JSONL проходит общую redaction из AM-01.

## Не входит в scope

- TUI slash command и extension UI.
- Remote/cloud audit upload.
- Полноценная log rotation beyond session file.

## Предполагаемые файлы

- Kilo-owned CLI module под `packages/opencode/src/kilocode/cli/`
- точечная регистрация flag в `packages/opencode/src/cli/cmd/run.ts`
- Auto state/activation modules
- CLI rendering tests и integration test

## DoD

- `kilo run --auto-mode` активирует gateway; обычный `kilo run` не меняет поведения.
- `--auto` и `--auto-mode` имеют документированную различную семантику; опасная комбинация не ослабляет Auto Mode.
- Live trace показывает pre/post verdict, apply/discard и duration.
- JSONL содержит все обязательные lifecycle stages и проходит secret redaction test.
- Итоговые counts совпадают с events.
- Startup на unsupported backend завершает работу до первого tool call.
- CLI help и relevant docs обновлены.
- Typecheck, targeted tests, source-link extraction при необходимости и annotation check проходят; создан `implementation/AM-08.md`.

## Handoff

AM-09 использует audit JSONL как источник метрик, а не парсит оформленный terminal text.
