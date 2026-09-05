# AM-03 — Security filesystem observer

Статус: complete
Commit/ветка: `b391948e61` / `main` (изменения в working tree, отдельный commit не создавался)

## Что сделано

- Добавлен прямой filesystem manifest, не использующий пользовательский Git index, `.gitignore` или обычный Snapshot output.
- Manifest фиксирует regular files, directories и symlinks: canonical relative path, тип, размер, executable bit, SHA-256 содержимого или link target и сам symlink target.
- Реализован детерминированный diff для create/modify/delete, executable bit, изменения symlink target и type changes.
- `.git` на любой глубине и переданные вызывающим кодом internal storage roots исключаются из обхода.
- Добавлены cancellation, лимиты entries/размера файла/общего объёма и fail-closed diagnostics для read/race/unsupported/limit errors.
- Добавлены integration tests на реальной файловой системе, включая ignored path, binary, Unicode, symlinks, limits и конкурентное изменение файла.

## Фактическая архитектура

- `Manifest.capture` в `packages/opencode/src/kilocode/auto/manifest.ts` канонизирует workspace root через `realpath`, сортирует имена byte-wise и обходит все entries напрямую через filesystem API.
- Regular file открывается с `O_NOFOLLOW` на macOS/Linux. `lstat`, opened file stat, post-read handle stat и повторный `lstat` должны совпасть; иначе capture содержит безопасную диагностику `race`.
- Symlink обрабатывается только через `lstat` и `readlink`: target не открывается и не хешируется как файл. Хешируется только строка target.
- `Observe.diff` в `packages/opencode/src/kilocode/auto/observe.ts` принимает два manifests и возвращает canonical `ActionEffect[]`. Type change представлен `file.delete` старого entry и create-effect нового типа.
- Если любой manifest неполон или roots не совпадают, `Observe.diff` не доверяет частичному результату и возвращает единственный effect `unknown` вместе со структурированными diagnostics. Проверка через публичный `Policy.evaluate` приводит к `AUTO_UNKNOWN_EFFECT`.
- File contents не входят ни в manifest, ни в effects/diagnostics. Manifest хранит только SHA-256; будущая workspace transaction AM-04 должна передавать apply bytes отдельным внутренним каналом.

## Изменённые файлы

- `packages/opencode/src/kilocode/auto/manifest.ts`
- `packages/opencode/src/kilocode/auto/observe.ts`
- `packages/opencode/test/kilocode/auto/observe.test.ts`
- `docs/auto-mode-hackathon/specs/AM-03-observer.md`
- `docs/auto-mode-hackathon/specs/README.md`
- `docs/auto-mode-hackathon/implementation/AM-03-observer.md`

## Проверки и результаты

- `cd packages/opencode && /Users/hchgssarwyh/.bun/bin/bun test ./test/kilocode/auto/audit.test.ts ./test/kilocode/auto/policy.test.ts ./test/kilocode/auto/observe.test.ts` — 49 pass, 0 fail.
- `cd packages/opencode && /Users/hchgssarwyh/.bun/bin/bun run typecheck` — успешно.
- `cd packages/opencode && /Users/hchgssarwyh/.bun/bin/bunx prettier --check src/kilocode/auto/manifest.ts src/kilocode/auto/observe.ts test/kilocode/auto/observe.test.ts` — успешно.
- `bun run script/check-opencode-annotations.ts --worktree` из корня — успешно, shared upstream files не изменялись.
- `bun run script/check-md-table-padding.ts` из корня — успешно.

Абсолютный путь к Bun использован потому, что binary не присутствует в `PATH` текущего shell.

## Отклонения от ТЗ

- Файл отчёта назван `AM-03-observer.md` по общему шаблону `AM-NN-<slug>.md` и соглашению уже созданных отчётов, хотя DoD задачи сокращённо упоминает `implementation/AM-03.md`.
- Observer не публикует lifecycle event самостоятельно: AM-03 не подключает gateway/action lifecycle. Его effects и безопасные diagnostics готовы для event `observed`, который будет публиковать AM-05.

## Известные ограничения

- Лимиты MVP: 100 000 entries, 4 096 символов на path/link target, 64 MiB на один regular file и 512 MiB суммарно на capture. Превышение любого лимита даёт `unknown`, а не частичный безопасный diff.
- Обход является последовательным и ориентирован на корректность демо, а не на производительность больших monorepo.
- Manifest хранит directory metadata для безопасного обхода и определения type transitions. Самостоятельное создание/удаление пустого каталога не создаёт effect, поскольку в доменной модели AM-01 нет directory category; переход directory↔file/symlink отражается доступными create/delete effects.
- Observer обнаруживает гонки по inode/device/mode/size/mtime/ctime до и после чтения. Production-grade защита от adversarial directory replacement потребует descriptor-relative `openat` traversal в platform helper; обнаруженная гонка в текущем MVP всегда приводит к `unknown`.

## Handoff следующему агенту

AM-04 должен сохранять `Manifest.Info` для checkpoint и conflict detection и использовать `Observe.diff` без изменения формата effects. Internal storage shadow/checkpoint нужно передавать в `Manifest.capture({ internal: [...] })`. При `diagnostics.length > 0` нельзя применять даже безопасную часть diff; apply bytes должны читаться отдельным каналом только после post-policy `ALLOW`.
