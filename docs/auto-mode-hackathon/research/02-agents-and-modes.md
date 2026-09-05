# Как сейчас устроены режимы

## Терминология

В текущем CLI «режим» — это агент. Отдельной runtime-сущности `Mode`, которая меняет security pipeline, нет. Выбранный `Agent.Info` задаёт:

- имя и описание;
- `mode: primary | subagent | all` — где агент можно использовать;
- system prompt;
- model/variant/options;
- набор permission rules;
- видимость и системный статус.

В сообщениях поля `mode` и `agent` обычно содержат имя выбранного агента. Старые файлы `{mode,modes}/*.md` загружаются как agent configs с `mode: primary`; это слой обратной совместимости.

Не путать это с:

- `kilo run --auto` — клиент автоматически отвечает `once` на permission prompts;
- `/auto-approve` — сохраняет глобальное правило `* → allow`;
- `--yolo` / `--dangerously-skip-permissions` — скрытый headless-вариант автоответа;
- моделью `kilo-auto/...` — маршрутизация модели, а не permission mode;
- `/sandbox` — отдельный переключатель confinement для сессии.

## Встроенные primary-режимы

Агенты сначала создаются в `packages/opencode/src/agent/agent.ts`, затем Kilo меняет и дополняет их через `KiloAgent.patchAgents` из `packages/opencode/src/kilocode/agent/index.ts`.

| Режим | Назначение | Главное поведение permissions |
|---|---|---|
| `code` | Режим по умолчанию, бывший upstream `build` | Почти все tools разрешены по defaults; shell использует allowlist и `ask` для остального; user rules могут уточнять поведение |
| `debug` | Диагностика и исправление проблем | По правам близок к `code`, отличается prompt; разрешены question/suggest/plan_enter/semantic_search |
| `plan` | Исследование и создание плана | Запрещает произвольные изменения; допускает edit только план-файлов; shell ограничен read-only allowlist; может делегировать, кроме `general` по умолчанию |
| `ask` | Ответы и объяснения без изменения проекта | Read-only allowlist, `edit` и мутирующие/исполняющие tools жёстко закрыты |
| `orchestrator` | Делегирование сложной работы | Сам почти ничего не меняет, `bash` жёстко запрещён, разрешены task/read/search/todo; помечен deprecated |

Системные hidden primary-agents:

- `compaction`;
- `title`;
- `summary`.

Для них `KiloAgent.hardenSystemAgents` в конце сборки принудительно ставит единственное правило `* → deny`, чтобы user config не открыл им tools.

## Встроенные subagents

| Агент | Назначение | Ограничения |
|---|---|---|
| `general` | Общие многошаговые подзадачи | Почти defaults, но без `todowrite`; выполняется в дочерней session |
| `explore` | Поиск и исследование кодовой базы | Read/search tools; shell только read-only allowlist; user allow не может сделать shell пишущим |
| `scout` | Внешняя документация и dependency source | Опционален по feature flag; read-only доступ к cache/reference paths |

Custom agent без явного mode получает `mode: all`, если создаётся через config loop. Agent builder по умолчанию предлагает `primary`.

## Как выбирается режим

`Agent.Service.defaultInfo`:

1. Использует `config.default_agent`, если он существует, не hidden и не subagent.
2. Иначе выбирает `code`.
3. Иначе первый видимый non-subagent агент.

CLI `kilo run --agent <name>` проверяет, что агент существует и не является subagent. При создании user message выбранный агент сохраняется в message и session; последующие шаги получают его из последнего user message/session.

TUI показывает и переключает primary/all agents. Делегируемые агенты вызываются через `task`, а не выбираются как основной режим.

## Слияние permission-настроек агента

Базовые defaults включают `* → allow`, но поверх них идут более конкретные ограничения:

- `doom_loop → ask`;
- внешние директории обычно `ask`, служебные Kilo paths разрешены;
- `.env` и `.env.*` требуют вопроса;
- question/interactive tools зависят от типа агента;
- Kilo добавляет shell allowlist, memory rules и client-specific permissions;
- user config добавляется позже и обычно имеет приоритет из-за last-match semantics.

Для `ask`, `plan` и legacy `architect` действует дополнительное hardening. `KiloSessionPrompt.buildAskRuleset` формирует как обычный `ruleset`, так и `hardRuleset`. Сохранённое разрешение или глобальный auto-approve не должны отменить hard deny этих read-only режимов.

Набор особо защищённых permissions определён в `KiloAgent.guarded`:

```text
bash, task, notebook_edit, notebook_execute, write,
agent_manager, repo_clone, interactive_terminal
```

`edit` защищается отдельными edit guards. Это сделано так, чтобы глобальное wildcard-разрешение не превращало `ask` или `plan` в пишущий режим.

## Три существующих варианта «автоматического разрешения»

### `kilo run --auto`

Headless CLI слушает события `permission.asked` и отвечает `once` для root session и известных Task children. Явный `deny` срабатывает до появления события и не обходится. Запросы `skillShell` и `sandboxEscalation` автоматически отклоняются: им нужен интерактивный человек.

### `/auto-approve`

TUI вызывает endpoint `Permission.allowEverything`, который сохраняет глобальную конфигурацию `* → allow`. Это влияет на все клиенты. Hard rules read-only режимов, config protection и forced human asks продолжают действовать.

### Скрытые `--yolo` / `--dangerously-skip-permissions`

В `kilo run` эти флаги означают автоматический ответ `once` на вопросы вместо стандартного headless auto-reject. Они не удаляют `ctx.ask` из инструментов и не отменяют deny, вынесенный до pending request. Название сильнее фактической реализации.

## Что это значит для нового Auto Mode

Новый режим не следует реализовывать как ещё один клиентский auto-replier. Такой вариант видит только итоговый `ASK`, не анализирует эффекты и не контролирует выполнение.

Минимально разумные варианты интеграции:

- новый primary agent `auto`, который задаёт UX и базовый ruleset;
- отдельная security policy, активируемая для session независимо от `Agent.Info`;
- общий execution gateway ниже модели и выше реального `Tool.Def.execute`.

Последний пункт обязателен независимо от того, как режим будет отображаться пользователю.

