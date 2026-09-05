# AM-04 — Shadow workspace transaction

Статус: complete
Commit/ветка: `b391948e61` / `main` (изменения в working tree, отдельный commit не создавался)

## Что сделано

- Добавлен session shadow в Kilo-controlled temp с первичной materialization всех regular files, каталогов и безопасных symlinks без `.git` и без hardlinks.
- Реализован `Workspace.transaction`, удерживающий mutex от checkpoint до `apply`/`discard`; незавершённая или упавшая transaction автоматически discard-ится.
- Checkpoint сохраняет security manifests original и shadow, а также независимую полную копию shadow для восстановления.
- `apply` повторно строит manifest shadow, сверяет переданный observed set с точным `Observe.diff`, проверяет original baseline и переносит только затронутые paths.
- Conflict возвращает решение с `AUTO_APPLY_CONFLICT`, не перезаписывает original и пересинхронизирует shadow с пользовательским состоянием.
- Частичная ошибка apply запускает компенсирующий rollback; success не возвращается, пока весь change set не применён.
- Terminal operations передают `trial_started`, `applied`, `discarded` или `failed`, durations и counts через обязательный audit sink. Реальное подключение sink к `Audit.publish` остаётся за Gateway AM-05.
- Cleanup удаляет только внутренний session storage и не следует по symlinks.

## Фактическая архитектура

- `Copy.Backend` в `packages/opencode/src/kilocode/auto/copy.ts` скрывает стратегию materialization. Локальный backend рекурсивно копирует bytes и mode, воспроизводит symlinks без разыменования и исключает `.git` на любой глубине.
- `Workspace.create` в `packages/opencode/src/kilocode/auto/workspace.ts` создаёт один shadow под `Global.Path.tmp`; тестовый `temp` разрешён только вне original root.
- `Workspace.Handle.transaction` использует promise-chain mutex. Перед новым action shadow автоматически пересинхронизируется, если original изменился между actions.
- `Transaction.observe` использует публичный `Observe.diff`; `Transaction.apply` не доверяет ранее вычисленному result и требует его byte-equivalent совпадения с новым security diff.
- Conflict detection сравнивает baseline не только для изменяемых paths, но и для всех их ancestors, поэтому замена parent directory на symlink не приводит к overwrite.
- Apply сначала сохраняет минимальные затронутые subtrees, затем удаляет targets от глубоких к мелким и создаёт их от мелких к глубоким. При исключении восстановление идёт из backup; ошибка восстановления имеет отдельный `AUTO_ROLLBACK_FAILED`.

## Изменённые файлы

- `packages/opencode/src/kilocode/auto/copy.ts`
- `packages/opencode/src/kilocode/auto/workspace.ts`
- `packages/opencode/test/kilocode/auto/workspace.test.ts`
- `docs/auto-mode-hackathon/specs/AM-04-shadow-workspace.md`
- `docs/auto-mode-hackathon/specs/README.md`
- `docs/auto-mode-hackathon/notes/decisions.md`
- `docs/auto-mode-hackathon/implementation/AM-04-shadow-workspace.md`

## Проверки и результаты

- `cd packages/opencode && /Users/hchgssarwyh/.bun/bin/bun test ./test/kilocode/auto/audit.test.ts ./test/kilocode/auto/policy.test.ts ./test/kilocode/auto/observe.test.ts ./test/kilocode/auto/workspace.test.ts` — 56 pass, 0 fail.
- `cd packages/opencode && /Users/hchgssarwyh/.bun/bin/bun run typecheck` — успешно.
- `cd packages/opencode && /Users/hchgssarwyh/.bun/bin/bunx prettier --check src/kilocode/auto/copy.ts src/kilocode/auto/workspace.ts test/kilocode/auto/workspace.test.ts` — успешно.
- `bun run script/check-opencode-annotations.ts --worktree` из корня — успешно, shared upstream files не изменялись.
- `bun run script/check-md-table-padding.ts` из корня — успешно.

## Отклонения от ТЗ

- Audit boundary реализована обязательным sink вместо прямой зависимости Workspace от Effect `Bus.Service`. Это позволяет AM-05 передать `Audit.publish` из уже существующего instance runtime и не создаёт новый Promise facade вокруг Effect service.
- Отчёт назван `AM-04-shadow-workspace.md` по шаблону `AM-NN-<slug>.md` из `implementation/README.md`, хотя сокращённая строка DoD упоминает `implementation/AM-04.md`.

## Известные ограничения

- Копирование последовательное и рассчитано на hackathon workspace, а не на большие monorepo.
- Absolute symlinks и relative symlinks наружу отклоняются при materialization. Поддержка безопасного rewrite абсолютных внутренних ссылок не реализована.
- Compensating rollback покрывает штатные filesystem errors, но crash всего process во время apply не восстанавливается, как и указано вне scope AM-04.
- Проверки paths используют `lstat`/`realpath` Node API. Они fail-closed обнаруживают изменения между manifest captures, но production-grade защита от adversarial TOCTOU непосредственно во время apply потребует descriptor-relative platform helper.
- Ошибка самого rollback возвращает `AUTO_ROLLBACK_FAILED`; после неё original нельзя считать синхронизированным автоматически.

## Handoff следующему агенту

AM-05 должен создавать один `Workspace.Handle` на Auto Mode session, передавать audit sink, вызывающий общий `Audit.publish`, и выполнять mutating tool строго внутри `handle.transaction`. Tool получает только `tx.root`; после post-policy `ALLOW` Gateway передаёт неизменённый `Observe.Result` в `tx.apply`, а при `DENY`/отклонённом `ASK` вызывает `tx.discard`. Нельзя возвращать tool success до `status: applied`; `status: conflict` нужно отдать существующему human permission flow как `AUTO_APPLY_CONFLICT`. Gateway не должен передавать shadow/storage path в agent-facing result.
