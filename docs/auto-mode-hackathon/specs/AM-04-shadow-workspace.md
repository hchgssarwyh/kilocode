# AM-04 — Shadow workspace transaction

Статус: выполнено.

## Цель

Создать транзакционную рабочую копию session и операции checkpoint, discard и apply, гарантирующие отсутствие изменений настоящего workspace до post-verdict.

## Зависимости

AM-01–AM-03 выполнены.

## Scope

- Kilo-owned `Workspace` service/API.
- Один shadow root на Auto Mode session.
- Первичная materialization текущего workspace без `.git`.
- Per-action mutex и checkpoint.
- `discard(actionID)` для возврата shadow к состоянию до действия.
- `apply(actionID, observed)` для create/modify/delete/symlink/mode changes.
- Optimistic conflict detection по original baseline.
- Cleanup при штатном завершении и best-effort cleanup после ошибки.
- Lifecycle audit events и durations.

Backend копирования скрывается за интерфейсом. Первая реализация может использовать обычную файловую копию; нельзя использовать hardlinks для mutable files. Platform copy-on-write допустим только при идентичных тестах.

## Security invariants

- `.git` никогда не копируется в shadow и не применяется обратно.
- До `apply` bytes настоящего workspace не меняются.
- Команда не исполняется повторно в original workspace.
- Apply использует только observed allowlisted change set; новый незаявленный файл не переносится случайно.
- Original path, изменившийся после baseline, не перезаписывается: возвращается `AUTO_APPLY_CONFLICT`.
- Запись через symlink не выходит из original root.
- При частичной ошибке apply операция сообщает fail-closed result и не выдаёт `applied`. Для MVP допустим documented compensating rollback, покрытый тестом.

## Не входит в scope

- Tool execution.
- Shell sandbox.
- Crash recovery после убийства всего Kilo process.
- Оптимизация огромных monorepo.

## Предполагаемые файлы

- `packages/opencode/src/kilocode/auto/workspace.ts`
- `packages/opencode/src/kilocode/auto/copy.ts`
- `packages/opencode/test/kilocode/auto/workspace.test.ts`

## Тестовые сценарии

- Safe create/modify/delete применяется byte-for-byte.
- Denied action discard не меняет original и восстанавливает shadow.
- Ignored file участвует в apply/discard.
- Original concurrent edit вызывает conflict без overwrite.
- Partial apply error не маскируется как success.
- Cleanup не следует за symlink наружу.
- Две конкурентные mutation requests фактически исполняются последовательно.

## DoD

- Интеграционный тест доказывает: original hash до verdict неизменен.
- После safe apply original и shadow имеют одинаковый security manifest для change set.
- После discard shadow совпадает с checkpoint, original совпадает с baseline.
- Conflict и symlink escape покрыты тестами.
- Временная директория расположена в Kilo-controlled temp, а её путь не попадает в agent-facing message.
- Typecheck и targeted tests проходят; создан `implementation/AM-04.md`.

## Handoff

AM-05 подключает Workspace к tool gateway. Не добавлять CLI-флаг до AM-08.
