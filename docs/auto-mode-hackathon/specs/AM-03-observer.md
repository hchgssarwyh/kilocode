# AM-03 — Security filesystem observer

Статус: выполнено.

## Цель

Получать фактический filesystem diff одного действия независимо от пользовательского Git index и обычного Snapshot output, включая tracked, untracked и gitignored paths.

## Зависимости

AM-01 и AM-02 выполнены.

## Scope

- Security manifest для заданного workspace root.
- Сравнение двух manifests в normalized observed `ActionEffect[]`.
- Create/modify/delete, symlink target, executable bit и type change.
- Content hash для обнаружения изменения без сохранения contents в audit.
- Явные исключения `.git` и Auto Mode internal storage.
- Abort/cancellation и limits для хакатонного MVP.

Observer не должен использовать пользовательский `.git` index. Допускается переиспользовать низкоуровневые hashing/diff primitives, если они не исключают ignored paths.

## Security invariants

- Symlink не разыменовывается за пределы root.
- Path в результате всегда canonical relative path.
- Изменения ignored/untracked файлов видны.
- Ошибка чтения, race или превышение limit не приводит к пустому безопасному diff; возвращается `unknown`/fail-closed diagnostic.
- File contents не попадают в event/log. Для apply содержимое передаётся отдельным внутренним каналом Workspace transaction.

## Ограничения MVP

- Можно задать документированный лимит размера одиночного файла и числа entries.
- Производительность оптимизируется после корректности.
- Special devices и sockets внутри workspace запрещаются как unsupported.

## Предполагаемые файлы

- `packages/opencode/src/kilocode/auto/observe.ts`
- `packages/opencode/src/kilocode/auto/manifest.ts`
- `packages/opencode/test/kilocode/auto/observe.test.ts`

## Тестовые сценарии

- Modify tracked-like regular file.
- Create ignored `.vscode/tasks.json`.
- Create/delete untracked file.
- Binary file и executable bit.
- Symlink на path внутри и вне workspace.
- Filename с пробелом и Unicode.
- File меняется во время capture.
- Limit exceeded.

## DoD

- Все перечисленные изменения представлены корректными observed effects.
- Тест с `.gitignore` доказывает, что observer всё равно видит файл.
- Observer не читает содержимое внешней цели symlink.
- Race/limit/error даёт диагностируемый fail-closed результат.
- Audit events содержат только разрешённые summaries.
- Typecheck и targeted tests проходят; создан `implementation/AM-03.md`.

## Handoff

AM-04 использует manifest также для optimistic conflict detection, но не должен менять формат effects.
