# AM-02 — Deterministic policy engine

Статус: complete
Commit/ветка: `b391948e61` / `main` (изменения в working tree, отдельный commit не создавался)

## Что сделано

- Добавлен чистый публичный API `Policy.evaluate(input)`, который валидирует runtime input и возвращает `Decision` из AM-01.
- Обе фазы используют один упорядоченный registry правил с приоритетом `DENY > ASK > ALLOW`.
- Реализованы все минимальные rule codes AM-02 и дополнительный `AUTO_POLICY_ERROR` для fail-closed ошибок валидации или вычисления.
- Добавлена лексическая нормализация POSIX/Windows paths, включая alternate separators, traversal, Windows case folding и symlink targets.
- Persistence paths хранятся как данные рядом с правилами; покрыты VS Code tasks, Git hooks, shell startup files, CI/workflows и project hook directories.
- Добавлены tests для обеих фаз, hostile metadata, перестановок effects, 1 000 повторов, invalid input и исключений.

## Фактическая архитектура

- `Policy.Input` в `packages/opencode/src/kilocode/auto/policy.ts` принимает только доверенные структурированные поля: phase, tool, adapter status, shadow root, evaluated effects, optional declared effects и conflict flag. Неописанные agent labels/metadata удаляются runtime Schema и не участвуют в решении.
- `Policy.evaluate` является синхронной pure-функцией без filesystem, process или network effects. Она декодирует input, вызывает `Rules.decide` и повторно валидирует результат схемой `Decision`.
- `registry` в `packages/opencode/src/kilocode/auto/rules.ts` задаёт стабильный порядок правил. Итоговый verdict вычисляется независимо от порядка effects, а rule codes возвращаются в порядке registry.
- `AUTO_REMOTE_EXEC` для текущей структурной модели означает одновременное наличие `network.connect` и `process.exec`. Разбор shell-команды в эти эффекты остаётся задачей AM-06.
- Post-phase mismatch сравнивает нормализованные category/path/target опасных effects с declared set. Content fingerprint намеренно не участвует в сравнении ожидаемой формы эффекта.

## Изменённые файлы

- `packages/opencode/src/kilocode/auto/policy.ts`
- `packages/opencode/src/kilocode/auto/rules.ts`
- `packages/opencode/test/kilocode/auto/policy.test.ts`
- `docs/auto-mode-hackathon/specs/AM-02-policy.md`
- `docs/auto-mode-hackathon/specs/README.md`
- `docs/auto-mode-hackathon/implementation/AM-02-policy.md`

## Проверки и результаты

- `cd packages/opencode && /Users/hchgssarwyh/.bun/bin/bun test ./test/kilocode/auto/audit.test.ts ./test/kilocode/auto/policy.test.ts` — 41 pass, 0 fail.
- `cd packages/opencode && /Users/hchgssarwyh/.bun/bin/bun run typecheck` — успешно.
- `cd packages/opencode && /Users/hchgssarwyh/.bun/bin/bunx prettier --check src/kilocode/auto/policy.ts src/kilocode/auto/rules.ts test/kilocode/auto/policy.test.ts` — успешно.
- `bun run script/check-opencode-annotations.ts --worktree` из корня — успешно, shared upstream files не изменялись.
- `bun run script/check-md-table-padding.ts` из корня — успешно.

Абсолютный путь к Bun использован потому, что binary не присутствует в `PATH` текущего shell.

## Отклонения от ТЗ

- Добавлен rule code `AUTO_POLICY_ERROR`, отсутствующий в минимальном списке. Он нужен для явного fail-closed `DENY`, поскольку `AUTO_UNKNOWN_EFFECT` по контракту имеет verdict `ASK`.
- Остальной scope AM-02 выполнен без подключения policy к tools и без начала AM-03.

## Известные ограничения

- Нормализация paths является чистой лексической проверкой и не обращается к filesystem. Фактические symlink/race сведения должен предоставить observer из AM-03.
- Комбинация network и process effects консервативно считается remote execution. Более точную классификацию поддерживаемой shell grammar добавляет AM-06.
- `AUTO_APPLY_CONFLICT` использует доверенный boolean fact; обнаружение изменения original baseline относится к AM-04.
- Policy принимает adapter status от будущего Kilo-owned Gateway. Произвольные tools не должны формировать этот статус самостоятельно.

## Handoff следующему агенту

AM-03 должен вызывать только `Policy.evaluate`, передавать canonical observed `ActionEffect[]` и не копировать registry или persistence path lists. Observer должен выдавать symlink target metadata и fail-closed `unknown` effect при race/read/limit errors; policy сама filesystem не читает.
