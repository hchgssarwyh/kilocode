# AM-01 — Domain model и audit protocol

Статус: complete
Commit/ветка: `b391948e61` / `main` (изменения в working tree, отдельный commit не создавался)

## Что сделано

- Добавлены runtime Schema и выводимые TypeScript-типы `Action`, `ActionEffect`, `Verdict`, `Decision`, `RuleCode`, `Phase`, `ActionID` и audit-типы.
- Реализован детерминированный `createActionID`, связывающий `sessionID` с одним `callID`.
- Зарегистрировано lifecycle Bus-событие `auto.mode.action` и Kilo logger `auto.mode`.
- Реализован единый redaction pipeline для Bus payload, logger и канонической JSON-сериализации.
- Добавлены unit tests доменных схем, всех lifecycle-стадий, action ID, redaction и детерминированной сериализации.

## Фактическая архитектура

- `Action` в `packages/opencode/src/kilocode/auto/types.ts` содержит только нормализованные IDs, tool и declared/observed effects; сырые tool args в доменный объект не входят.
- `ActionEffect` использует обязательную категорию и ограниченные опциональные поля `path`, `target`, `fingerprint` для следующих частей ТЗ.
- `Decision` является union-схемой: `ASK` и `DENY` требуют непустой `ruleCodes`, `ALLOW` допускает пустой список.
- `AuditEvent` в `packages/opencode/src/kilocode/auto/event.ts` хранит только разрешённые IDs, lifecycle phase, категории effects, категоризированные paths, verdict, rule codes, counts, timing и безопасные diagnostics.
- `redact` в `packages/opencode/src/kilocode/auto/audit.ts` строит payload по белому списку, заменяет secret-like paths категориями `secret`/`external`, удаляет control characters, ограничивает summary и скрывает переданные env/secret values. `serialize` канонически сортирует object keys. `publish` отправляет тот же redacted payload в logger и Bus.

## Изменённые файлы

- `packages/opencode/src/kilocode/auto/types.ts`
- `packages/opencode/src/kilocode/auto/event.ts`
- `packages/opencode/src/kilocode/auto/audit.ts`
- `packages/opencode/test/kilocode/auto/audit.test.ts`
- `docs/auto-mode-hackathon/specs/AM-01-domain-audit.md`
- `docs/auto-mode-hackathon/specs/README.md`
- `docs/auto-mode-hackathon/implementation/AM-01-domain-audit.md`

## Проверки и результаты

- `cd packages/opencode && /Users/hchgssarwyh/.bun/bin/bun test ./test/kilocode/auto/audit.test.ts` — 7 pass, 0 fail.
- `cd packages/opencode && /Users/hchgssarwyh/.bun/bin/bun run typecheck` — успешно.
- `cd packages/opencode && /Users/hchgssarwyh/.bun/bin/bunx prettier --check src/kilocode/auto/types.ts src/kilocode/auto/event.ts src/kilocode/auto/audit.ts test/kilocode/auto/audit.test.ts` — успешно.
- `bun run script/check-opencode-annotations.ts --worktree` из корня — успешно, shared upstream files не изменялись.
- `bun run script/check-md-table-padding.ts` из корня — успешно, 402 Markdown-файла проверены.

Абсолютный путь к Bun использован потому, что установленный binary не присутствовал в `PATH` текущего shell.

## Отклонения от ТЗ

Нет. Реализация осталась в Kilo-owned paths; session activation, policy и tool interception не добавлялись.

## Известные ограничения

- AM-01 только определяет и тестирует протокол: реальные tool executions начнут публиковать события после подключения Gateway в AM-05.
- Произвольные значения секретов, не переданные redaction pipeline и не похожие на распространённые token formats, невозможно распознать эвристически. Сырые args, contents, stdout/stderr и headers не входят в allowlisted payload независимо от этого ограничения.
- `ActionEffect` намеренно не содержит policy semantics; конкретные правила и нормализация paths относятся к AM-02.

## Handoff следующему агенту

AM-02 должен импортировать `ActionEffect`, `Decision`, `Phase`, `RuleCode` и `Verdict` из `packages/opencode/src/kilocode/auto/types.ts`, не создавая параллельных verdict/effect типов. Решения policy следует передавать в `Audit.redact`/`Audit.publish`; текст и metadata агента не должны становиться rule input или audit summary.
