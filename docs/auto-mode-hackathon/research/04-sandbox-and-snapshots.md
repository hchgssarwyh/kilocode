# Существующие sandbox и snapshots

## Краткий ответ

Sandbox в CLI уже есть. Он реализован в двух слоях:

- `packages/opencode/src/kilocode/sandbox/` — конфигурация, session state, наследование и обёртка tool execution;
- `packages/kilo-sandbox/` — OS-level filesystem/process/network confinement.

Он поддерживает macOS и Linux, но не Windows. Это write/network boundary, а не privacy boundary: чтение файлов в основном не ограничивается.

Также есть отдельный `Snapshot.Service`, который создаёт снимки workspace через служебный Git repository и поддерживает diff/revert/restore. Snapshot не является sandbox и не изолирует выполнение.

## Конфигурация sandbox

Схема `SandboxConfig.Info`:

```text
sandbox.enabled: boolean          default false
sandbox.network: allow | deny     default deny
sandbox.writable_paths: string[]
sandbox.allowed_hosts: string[]
```

Если сеть запрещена и allowlist пуст — mode `deny`. Если есть allowed hosts — mode `proxy`. Если `network: allow` — mode `allow`.

Project config намеренно не может расширять доверенную sandbox policy. `SandboxConfig.scope` пропускает из local config только включение sandbox и ужесточение сети до deny; allowed hosts и дополнительные writable paths должны приходить из доверенного/global config.

## Активация и state

Sandbox включается для session через `/sandbox` в CLI. Есть HTTP endpoints:

```text
GET  /sandbox/support
GET  /session/:sessionID/sandbox
POST /session/:sessionID/sandbox/toggle
```

Эффективный initial state выбирается в порядке:

1. Явный toggle, сохранённый в metadata session.
2. Последняя preference для этой project directory.
3. `sandbox.enabled` из config.

Authoritative snapshot политики хранится отдельно под Kilo state directory в `kilo-sandbox-policy`, с ключом из hash sessionID и directory. Preference новых sessions хранится в `kilo-sandbox-preference`. Изменения доверенной конфигурации подхватываются перед следующим tool execution.

При включении sandbox session family должна быть idle. Останавливаются связанные background processes, interactive terminals и notebook requests. Subagents и forked sessions наследуют более строгую комбинацию политик:

- enabled остаётся true, если его требует parent или child;
- `deny` сети сильнее `proxy/allow`;
- allowlists пересекаются;
- дополнительные writable paths пересекаются.

## Что ограничивает профиль

`SandboxPolicy.profile` разрешает запись в:

- project/worktree directory;
- Kilo data/cache/state/tmp/bin/log/repository cache;
- явно доверенные дополнительные writable paths.

При этом запрещает запись в:

- sandbox policy/preference storage;
- Kilo global config;
- любой path component с именем `.git`.

Из environment удаляются чувствительные Kilo config/server/browser variables; TMPDIR/TMP/TEMP направляются в Kilo temp.

Важно: project workspace остаётся writable. Поэтому текущий sandbox не предотвращает создание `.vscode/tasks.json` внутри проекта. Для класса атак Auto Mode это только строительный блок, а не готовая защита.

## Backend по платформам

### macOS

Используется `/usr/bin/sandbox-exec` (Seatbelt). Профиль разрешает чтение, ограничивает filesystem writes allowlist/denylist и сеть. Команда запускается как дочерний процесс через sandbox-exec.

### Linux

Используется Bubblewrap: system `/usr/bin/bwrap` или проверенный bundled binary. Корень bind-mounted read-only, writable roots bind-mounted writable, `.git` и deny paths возвращаются read-only. Создаётся PID/user namespace; при restricted network также network namespace.

### Windows

Backend отсутствует. Если policy включена, affected tool получает ошибку; unrestricted fallback не выполняется.

## Сеть

Режимы:

- `allow` — сетевой трафик разрешён;
- `deny` — outbound network заблокирован;
- `proxy` — разрешены только точные public DNS destinations из `allowed_hosts`.

Proxy проверяет host/port, DNS public address и TLS SNI. Wildcards, IP literals, private/reserved addresses и неявные subdomains не допускаются.

Ограничение действует только внутри tool execution boundary. Model/provider traffic, trusted MCP lifecycle и plugin hooks находятся вне неё. Builtin tools с непрозрачной сетью, remote/local MCP calls и неизвестные custom tools блокируются при restricted network.

## Как sandbox применяется к разным операциям

`SandboxPolicy.executeTool` устанавливает `CurrentProfile` на время effect и добавляет network classification. Далее:

- процессы перехватываются через `@kilocode/sandbox.prepareCommand` в `CrossSpawnSpawner`;
- Effect filesystem декорируется через `decorateFileSystem`;
- Effect HTTP client декорируется sandbox-aware layer;
- filesystem mutations выполняются отдельным worker process, также confined OS backend;
- direct shell process запускается внутри Seatbelt/Bubblewrap;
- MCP выполняется через `executeMcp` и fail-closed network assertion.

`unrestricted(effect)` явно снимает `CurrentProfile`. Сейчас это используется для ручной sandbox escalation: мутирующая Git-команда просит отдельное подтверждение, затем выполняется вне sandbox.

## Ограничения текущего sandbox для Auto Mode

- Не создаёт одноразовую копию workspace.
- Не откладывает применение изменений до verdict.
- Не строит observed effect list.
- Не ограничивает чтение доступных пользователю файлов.
- Workspace writable целиком, кроме `.git` и специальных paths.
- Plugin hooks работают вне boundary.
- Некоторые host/interactive/background tools недоступны вместо изолированного выполнения.
- Не поддерживается на Windows.

## Snapshot subsystem

`Snapshot.Service` в `packages/opencode/src/snapshot/index.ts` использует отдельный bare-like Git repository под Kilo data directory. Он не меняет пользовательский `.git` index.

Основные операции:

| Метод | Назначение |
|---|---|
| `track()` | Добавляет изменённые/новые неигнорируемые файлы в служебный index и возвращает tree hash |
| `patch(hash)` | Возвращает список файлов, изменившихся между hash и текущим staged workspace state |
| `diff(hash)` | Возвращает unified diff от hash до текущего состояния |
| `restore(hash)` | Восстанавливает весь служебный tree в workspace |
| `revert(patches)` | Восстанавливает только файлы из набора patch checkpoints |
| `diffFull(from,to)` | Строит структурированные file diffs между двумя snapshot hashes |

Ограничения snapshot:

- Работает только для Git projects и отключается config `snapshot: false`.
- Исключает gitignored files из пользовательского patch output.
- Очень большие untracked files могут исключаться.
- Captures делаются вокруг LLM step, а не атомарно вокруг каждого tool call.
- Restore/revert меняют настоящий workspace постфактум; внешние эффекты и сеть не откатываются.
- Snapshot tracking может быть медленным и имеет UX для continue/disable.

## Потенциал переиспользования

Для хакатонного прототипа Snapshot primitives подходят для:

- baseline перед отдельным tool call;
- список реально изменённых файлов после выполнения;
- содержимое/diff для policy engine;
- rollback изменённых workspace-файлов при deny.

Но необходимо отдельно решить:

- как включить ignored/untracked sensitive artifacts в security diff;
- как сериализовать параллельные tool calls;
- как гарантировать rollback при падении процесса;
- как отличить изменения агента от параллельных изменений пользователя;
- как покрыть writes вне workspace и внешние эффекты.

Поэтому существующий Snapshot — хороший механизм demo rollback, но не доказательство полной изоляции.

