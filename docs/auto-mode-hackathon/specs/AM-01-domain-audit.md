# AM-01 — Domain model и audit protocol

Статус: выполнено.

## Цель

Создать Kilo-owned доменную границу Auto Mode: типы action/effect/verdict, session-independent audit events и безопасную redaction. На этом этапе режим не включается пользователю и tools не перехватываются.

## Зависимости

Нет. Прочитать `architecture/01-target-design.md` и research-документы.

## Scope

- Новый модуль `packages/opencode/src/kilocode/auto/`.
- Schema-типы `Action`, `ActionEffect`, `Verdict`, `Decision`, `RuleCode`, `Phase`.
- Стабильный `actionID`, связанный с `sessionID` и одним tool call.
- Bus event для lifecycle action и Kilo logger `auto.mode`.
- Одна функция redaction/serialization для Bus, logger и будущего JSONL.
- Unit tests схем, сериализации и redaction.

Минимальные категории `ActionEffect`:

```text
file.read
file.write
file.delete
file.symlink
process.exec
network.connect
package.install
persistence.create
unknown
```

Decision содержит `phase`, `verdict`, непустой список rule codes для `ASK`/`DENY` и безопасный summary. Текст от агента не является частью правила.

## Audit contract

Стадии: `received`, `precheck`, `trial_started`, `trial_finished`, `observed`, `postcheck`, `applied`, `discarded`, `failed`, `returned_to_agent`.

Событие допускает IDs, tool, категорию effect, относительный не-secret path, verdict, rule codes, counts и duration. Запрещены file contents, полный stdout/stderr, environment values, tokens, headers и произвольный удалённый текст.

Redaction должна:

- скрывать значения env/secrets независимо от регистра ключа;
- не публиковать содержимое tool args целиком;
- заменять secret-like path безопасной категорией;
- ограничивать длину безопасных сообщений;
- быть детерминированной.

## Не входит в scope

- Policy rules.
- Session activation.
- CLI rendering и JSONL persistence.
- Tool interception.

## Предполагаемые файлы

- `packages/opencode/src/kilocode/auto/types.ts`
- `packages/opencode/src/kilocode/auto/event.ts`
- `packages/opencode/src/kilocode/auto/audit.ts`
- `packages/opencode/test/kilocode/auto/audit.test.ts`

Имена могут быть скорректированы по существующим conventions, но код должен оставаться в Kilo-owned paths.

## DoD

- Все domain types имеют runtime Schema и выводимый TypeScript type.
- Для каждой lifecycle phase можно создать валидное redacted event.
- Тест доказывает, что token, env value, file content и raw stdout не попадают в serialized event.
- Одинаковый input даёт одинаковую сериализацию за исключением явно переданного timestamp/duration.
- `bun run typecheck` и targeted tests из `packages/opencode/` проходят.
- Создан `implementation/AM-01-domain-audit.md` с фактическими symbols и результатами проверок.

## Handoff

AM-02 импортирует типы, но не должен вводить параллельную модель verdict/effect.
