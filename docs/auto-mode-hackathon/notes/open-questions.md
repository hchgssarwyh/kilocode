# Открытые вопросы после исследования текущего кода

## Неблокирующие вопросы MVP

1. Где находится описанное в продуктовых материалах ядро с 78 тестами? В текущем checkout оно не найдено, поэтому ТЗ самодостаточно и предполагает минимальную реализацию в этом репозитории. Если ядро будет предоставлено позже, его можно адаптировать за Kilo-owned интерфейсами.
2. Какой механизм копирования окажется достаточно быстрым на реальных проектах: обычная копия, platform copy-on-write или иной backend? Контракт транзакции не должен зависеть от выбранной оптимизации.
3. Нужна ли после хакатона поддержка Windows и какой isolation backend для неё допустим?
4. Нужен ли после MVP opt-in network allowlist? В MVP исходящая сеть запрещена, непрозрачное внешнее действие получает `ASK` или `DENY`.
5. Нужно ли после MVP запрещать чтение secret paths? Текущий sandbox является write/network boundary, не privacy boundary.

## Подтверждённые gaps

- Нет универсальной модели effects.
- Нет per-tool pre/post snapshot.
- Нет quarantine workspace и commit-after-verdict.
- Нет policy для auto-exec paths.
- Нет structured denial с rule codes, предназначенного для replan агента.
- Package installation не выделена в отдельный перехватываемый operation.
- Plugin hooks остаются вне sandbox.
- Windows sandbox backend отсутствует.

## Решения, закреплённые в ТЗ

- Security capture включает tracked, untracked и gitignored paths и не зависит от обычного пользовательского Snapshot output.
- Изменяющие tool calls сериализуются session-level mutex.
- Доменный тип называется `ActionEffect`, чтобы не конфликтовать с библиотекой Effect.
- MCP, custom/plugin, background, interactive и subagent tools работают fail-closed до появления явного адаптера.
