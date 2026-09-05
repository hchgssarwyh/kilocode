# AM-02 — Deterministic policy engine

Статус: выполнено.

## Цель

Реализовать независимый от LLM policy engine, который одинаково оценивает declared effects до исполнения и observed effects после него.

## Зависимости

AM-01 выполнена.

## Scope

- Pure API `Policy.evaluate(input) -> Decision` без filesystem/process/network side effects.
- Фазы `pre` и `post` используют один rule registry.
- Детерминированный порядок правил и стабильный приоритет `DENY > ASK > ALLOW`.
- Rule codes и минимальные правила MVP.
- Tests для hostile metadata и повторяемости.

Минимальные rule codes:

| Code | Verdict | Условие |
|---|---|---|
| `AUTO_UNKNOWN_EFFECT` | `ASK` | Нет надёжной классификации |
| `AUTO_UNSUPPORTED_TOOL` | `DENY` | Tool может воздействовать на среду без адаптера |
| `AUTO_OUTSIDE_WORKSPACE` | `DENY` | Write/delete/symlink выходит из shadow root |
| `AUTO_GIT_INTERNALS` | `DENY` | Изменение любого `.git` component |
| `AUTO_PERSISTENCE_PATH` | `DENY` | Auto-exec/persistence artifact |
| `AUTO_NETWORK` | `ASK` | Явный обратимый network intent, не выполняемый пробно |
| `AUTO_REMOTE_EXEC` | `DENY` | Download/pipe/eval удалённого содержимого |
| `AUTO_PACKAGE_INSTALL` | `ASK` | Установка/изменение зависимости до AM-07 |
| `AUTO_EFFECT_MISMATCH` | `DENY` | Наблюдаемый опасный эффект отсутствовал в declared set |
| `AUTO_APPLY_CONFLICT` | `ASK` | Original изменился после baseline |

Persistence paths MVP должны включать как минимум `.vscode/tasks.json`, Git hooks, shell startup files внутри workspace, CI/workflow definitions и исполняемые project hooks. Список хранится как данные рядом с rule, а не размазывается по tools.

## Security invariants

- Agent-provided description не может понизить verdict.
- Неизвестная категория не становится `ALLOW`.
- Нормализация path выполняется до matching; `..`, alternate separators и symlink metadata не обходят правила.
- При нескольких совпадениях итог не зависит от порядка effects.
- Исключение rule engine преобразуется в fail-closed `DENY`, а не bypass.

## Не входит в scope

- Shell parser.
- Package metadata lookup.
- Human prompt.
- Применение решений к tools.

## Предполагаемые файлы

- `packages/opencode/src/kilocode/auto/policy.ts`
- `packages/opencode/src/kilocode/auto/rules.ts`
- `packages/opencode/test/kilocode/auto/policy.test.ts`

## DoD

- Табличные тесты покрывают каждый rule code в pre/post phase.
- Есть тесты path traversal, Windows separators как входных данных, mixed case там, где filesystem semantics это требуют, и hostile labels.
- Не менее 1 000 повторов одного набора effects дают byte-equivalent decision payload без временных полей.
- Перестановка effects не меняет итоговый verdict/rule codes.
- Ошибка/невалидный effect даёт fail-closed result.
- Typecheck и targeted tests проходят; создан `implementation/AM-02.md`.

## Handoff

Следующие задачи используют только публичный API Policy; правила не копируются в observer или gateway.
