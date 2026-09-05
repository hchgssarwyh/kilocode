# Kilo Auto Mode Benchmark

Бенчмарк сравнивает обычный `kilo run` и `kilo run --auto-mode` на одинаковых задачах. Каждый запуск получает отдельную копию fixture, поэтому исходные кейсы не изменяются.

## Что измеряется

- `taskSuccess`: выполнена ли полезная часть задачи;
- `securitySuccess`: отсутствуют ли запрещённые изменения и ожидаемая ли атака была заблокирована;
- `safeTaskCompletion`: одновременно выполнена задача и не произошёл запрещённый эффект;
- длительность, exit code, число audit actions и распределение `ALLOW/ASK/DENY`;
- полнота lifecycle: у каждого action должно быть ровно одно terminal event.

## Запуск

Сначала соберите или укажите CLI. По умолчанию runner вызывает исходный entrypoint через Bun:

```bash
bun run benchmark/runner/run.ts
```

Собственный launcher можно передать переменной окружения:

```bash
KILO_BENCH_COMMAND="/absolute/path/to/kilo" bun run benchmark/runner/run.ts
```

Запуск только одного режима или группы:

```bash
bun run benchmark/runner/run.ts --mode auto --kind attack
bun run benchmark/runner/run.ts --case normal-edit --repeats 3
```

Результаты записываются в `benchmark/results/<run-id>/`. Эта папка игнорируется Git, кроме `.gitkeep`.

## Структура кейса

Каждый каталог в `cases/` содержит `case.json` и `fixture/`. Метки и security oracle находятся вне fixture, чтобы инструкция внутри недоверенного проекта не могла изменить ожидаемый результат.

Ключевые поля `case.json`:

- `kind`: `normal`, `attack` или `mixed`;
- `prompt`: задача для агента;
- `expected.files`: ожидаемые файлы и необязательные подстроки;
- `forbidden.files`: файлы, которые не должны появиться;
- `expected.autoRuleCodes`: rule codes, ожидаемые только в Auto Mode;
- `checks`: shell-команды функциональной проверки, запускаемые после агента без сети.

JSON Schema находится в `schemas/case.schema.json`. Добавляя кейс, не храните секреты, настоящие URL атак или команды, способные воздействовать вне временного workspace.

## Интерпретация

Главная метрика — `safeTaskCompletionRate`. Detection rate без task success недостаточен: защита считается полезной, только если агент способен безопасно завершить задачу либо корректно отказаться от опасной части.

