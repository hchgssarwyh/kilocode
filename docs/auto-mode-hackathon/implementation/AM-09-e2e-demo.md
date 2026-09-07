# AM-09 — E2E demo, attacks и метрики

Статус: complete
Commit/ветка: `b391948e61` / `main` (изменения в working tree, отдельный commit не создавался)

## Что сделано

- Добавлен standalone demo runner без LLM/API credentials, вызывающий настоящий Gateway и macOS/Linux sandbox.
- Добавлен self-contained fixture project и шесть обязательных сценариев с пятью атаками.
- Safe edit/test, original-before-verdict, immediate apply, full-action discard, structured replan, pre-execution deny и
  unsupported tool fail-closed проверяются автоматически.
- Audit events получили durations для precheck, observe и post-policy; trial и apply/discard durations сохранены.
- Добавлен JSONL metrics aggregator: verdict/phase counts, action rates, attacks, false positives, phase durations,
  deterministic decision hash и actions без единственного terminal event.
- Добавлен E2E regression test, который проверяет output workspace, redaction и одинаковый decision hash на чистых
  повторных запусках.
- Добавлены инструкция выступающему, зафиксированный локальный результат и финальный tool coverage/bypass review.

## Фактическая архитектура

- `script/kilocode/auto-mode-demo.ts` создаёт уникальный fixture workspace, использует `AutoModeCLI.create` для того же
  mode `0600` JSONL sink и активирует `Gateway` с live renderer.
- File actions выполняются через Gateway transaction, shell actions дополнительно проходят `SandboxPolicy.executeAuto`;
  callbacks опасных precheck-сценариев имеют counters, доказывающие отсутствие исполнения.
- `Metrics` декодирует каждую JSONL-строку runtime Schema. Malformed/partial input завершает расчёт ошибкой, а не выдаёт
  частичные показатели.
- Action verdict для долей — самый строгий verdict action (`DENY > ASK > ALLOW`). Labels normal/attack передаются
  доверенным runner-кодом и не читаются из hostile fixture.
- Decision hash включает стабильные redacted pre/post decisions и исключает timestamps, durations и filesystem output
  paths запуска.

## Изменённые файлы

- `packages/opencode/src/kilocode/auto/gateway.ts`
- `packages/opencode/src/kilocode/auto/metrics.ts`
- `packages/opencode/script/kilocode/auto-mode-demo.ts`
- `packages/opencode/test/kilocode/auto/e2e.test.ts`
- `packages/opencode/test/kilocode/auto/fixtures/demo/*`
- `docs/auto-mode-hackathon/demo/README.md`
- `docs/auto-mode-hackathon/demo/results.md`
- `docs/auto-mode-hackathon/specs/AM-09-e2e-demo.md`
- `docs/auto-mode-hackathon/specs/README.md`
- `docs/auto-mode-hackathon/notes/decisions.md`
- `docs/auto-mode-hackathon/implementation/AM-09.md`

## Проверки и результаты

- `cd packages/opencode && bun test ./test/kilocode/auto/e2e.test.ts` — 3 pass, 0 fail; настоящий Seatbelt, три demo runs.
- Standalone `bun run --cwd packages/opencode script/kilocode/auto-mode-demo.ts` — 6/6 scenarios, 5/5 attacks,
  0 false positives, 0 unterminated actions.
- Decision hash standalone и повторных test runs:
  `4379c6d87c2e4bd6592ed2a6a6684ad737e74ce8e6ec6d91913653de9469cec7`.
- Остальные финальные команды и их результаты записываются после полного verification pass.

## Отклонения от ТЗ

- Runner намеренно не вызывает LLM. Детерминированная suite доказывает security execution path; качество agent decisions
  и prompt following измеряет отдельная хакатонная repository с реальной моделью.
- Package scenario использует direct URL package spec и отклонённый `ASK`. Реальный registry/install не запускается,
  поскольку network deny и отсутствие credentials являются обязательными свойствами локального fixture.
- Метрика apply объединяет apply/discard durations, поскольку это две terminal ветки одной transaction phase.

## Известные ограничения

- Это доказательство MVP-invariants, а не заявление production-grade безопасности.
- Windows, remote activation, MCP/subagent allowlists, interactive/background execution, crash recovery и privacy boundary
  остаются вне scope.
- Decision hash доказывает детерминизм policy decisions на фиксированном наборе actions, но не детерминизм LLM.
- Phase durations округляются до миллисекунд; быстрый policy evaluation закономерно может иметь значение `0 ms`.

## Handoff следующему агенту

Демо готово. Внешний benchmark должен запускать `kilo run --auto-mode --format json` с реальной LLM, брать audit path из
`auto_mode_summary`, валидировать JSONL terminal events и объединять security metrics с task-quality score. Не парсить
human `AUTO` trace и не передавать model-generated labels/reputation в trusted metrics/policy inputs.
