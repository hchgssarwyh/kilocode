# Инвентаризация CLI tools

## Зачем нужен этот список

Auto Mode должен контролировать не только shell. Ниже перечислены статические группы tools, которые `ToolRegistry` может показать модели в CLI. Фактический набор зависит от model, permissions, feature flags, подключённых MCP и plugins.

Источник сборки: `packages/opencode/src/tool/registry.ts`, Kilo additions: `packages/opencode/src/kilocode/tool/registry.ts`.

## Основные builtin tools

| Tool | Класс эффекта | Текущий контроль |
|---|---|---|
| `bash` | Process, filesystem, network, произвольный код | Tree-sitter permission patterns, external directory checks, OS sandbox |
| `read` | Filesystem read, directory listing, часть document extraction | `read` + `external_directory`; sandbox не является privacy boundary |
| `glob` | Filesystem metadata/read | Permission агента; без mutation |
| `grep` | Filesystem read, subprocess/ripgrep | Permission агента; process может быть confined |
| `edit` | Один filesystem write | Предварительный diff + `edit` permission, затем sandbox-aware FS |
| `write` | Полная запись файла | Предварительный diff + `edit` permission, затем sandbox-aware FS |
| `apply_patch` | Несколько add/update/move/delete | Общий diff + `edit` patterns, затем sandbox-aware FS |
| `task` | Делегированная дочерняя session | `task:<agent>`, наследование permissions и sandbox |
| `webfetch` | HTTP/network + недоверенный ответ | `webfetch` permission, sandbox-aware HTTP |
| `websearch` | Network/provider-specific search | Permission и network classification |
| `skill` | Read инструкций; потенциальный skill shell | `skill`; shell-команды skill имеют отдельный forced-human путь |
| `todowrite` | Session-local state | Permission, без workspace mutation |
| `question` | Интеракция с человеком | Доступен primary modes/interactive clients |
| `plan_exit` | Смена режима/workflow | Permission, без прямой filesystem mutation |
| `suggest` | UI/session interaction | CLI-specific, permission-controlled |
| `invalid` | Обработка ошибочного вызова | Реального эффекта нет |

Для некоторых моделей registry выбирает `apply_patch` вместо `edit`; `write` при этом остаётся отдельным tool. Защита должна покрывать permission `edit`, а не опираться только на tool id.

## Kilo-specific CLI tools

| Tool/группа | Класс эффекта | Доступность |
|---|---|---|
| `recall` | Чтение session context | Встроен |
| `kilo_memory_recall` | Чтение project memory | Только при включённой memory |
| `kilo_memory_save` | Запись managed memory | Только при включённой memory |
| `background_process` | Долгоживущий process | CLI и VS Code; ограничен при sandbox activation |
| `interactive_terminal` | Человеко-управляемый process | Только primary agents в CLI; sandbox не поддерживает этот lifecycle |
| `semantic_search` | Index/read, потенциально непрозрачная сеть | Только при готовом indexing; блокируется при restricted network при необходимости |
| `generate_image` | Внешняя сеть/генерация | Experimental |
| `board_read`, `board_post` | Shared session state | Experimental shared board |
| `agent_manager_models` | Host/model metadata | При специальной конфигурации; обычно VS Code-oriented |
| `notify_user`, `send_file` | Внешняя доставка/remote session | Только при соответствующем remote connection status |
| `repo_clone`, `repo_overview` | Network + filesystem cache/read | Только experimental Scout |
| `execute` (code mode) | Вызовы MCP через сгенерированный код | Experimental; скрывается при restricted network |
| `lsp` | Language server process, возможная непрозрачная сеть | Experimental |

Некоторые Kilo extras присутствуют в registry, но фактически скрыты в CLI из-за client flags или отсутствия host service. Это не повод исключать их из threat model: feature flag или config может изменить каталог.

## Динамические расширения

### MCP

MCP tool definitions загружаются из подключённых servers. Их эффекты непрозрачны для Kilo. В обычном режиме на них накладывается permission по имени tool. В sandbox с restricted network вызовы блокируются как delegated authority.

Typed MCP resource tools (`list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`) добавляются отдельным кодом в `SessionTools.resolve` и используют permission `read` с patterns `mcp:<server>:...`.

### Plugin/custom tools

Custom tools загружаются из `{tool,tools}/*.{js,ts}` и установленных plugins. Plugin получает `Tool.Context`, включая bridge к `ask`, но сам решает, вызовет ли его. При restricted network неизвестный custom tool блокируется fail-closed. При разрешённой сети его filesystem/process effects не становятся автоматически известны policy engine.

## Приоритет покрытия для hackathon demo

Предлагаемая, но пока не утверждённая граница первой реализации:

1. `bash` — самый широкий источник эффектов.
2. `edit`, `write`, `apply_patch` — прямые файловые mutations.
3. `read` — защита секретных путей.
4. `webfetch` и сеть из `bash` — контролируемый egress.
5. `task` — либо запретить в Auto Mode, либо наследовать policy и сериализацию.
6. MCP/plugin/custom/background/interactive tools — deny в демо до появления надёжных adapters.

Эта граница должна быть оформлена как явная allowlist режима, иначе новый или experimental tool автоматически окажется вне анализа эффектов.

