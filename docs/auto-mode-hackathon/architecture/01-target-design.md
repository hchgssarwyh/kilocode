# Целевая архитектура Auto Mode

## Инвариант

Ни одно локальное изменяющее действие Auto Mode не воздействует на настоящий workspace до deterministic post-check. Проверенная команда не запускается повторно: в настоящий workspace переносится уже проверенный файловый результат.

## Поток действия

```text
tool call
  → gateway
  → declared effects
  → policy.before
      DENY → structured denial
      ASK  → human decision
      ALLOW/TRIAL
  → session mutex
  → checkpoint shadow workspace
  → tool execution under existing OS sandbox
  → observed filesystem effects
  → policy.after
      ALLOW → conflict check → apply result → tool result
      ASK   → human decision → apply or discard
      DENY  → discard → structured denial → agent replans
```

Read-only tools не требуют filesystem transaction, но всё равно проходят gateway и pre-check. Необратимые внешние действия никогда не выполняются пробно.

## Компоненты

Новый код по возможности живёт в `packages/opencode/src/kilocode/auto/`:

| Компонент | Ответственность |
|---|---|
| `State` | Session-level activation и наследование строгого режима |
| `Action` | Нормализованное описание tool call без доверия к объяснению агента |
| `ActionEffect` | Declared или observed filesystem/process/network/package effect |
| `Policy` | Детерминированный `ALLOW / ASK / DENY` и стабильные rule codes |
| `Gateway` | Обязательная граница всех tool executions и fail-closed routing |
| `Observe` | Security manifest и diff, включая ignored/untracked paths |
| `Workspace` | Shadow lifecycle, checkpoint, discard и безопасный apply |
| `Audit` | События, redaction, тайминги и итоговая статистика |

Shared OpenCode files меняются минимально и с `kilocode_change` markers. Kilo-specific реализация не должна размазываться по отдельным tools.

## Транзакционная модель

- Один shadow workspace создаётся на session и стартует из текущего состояния настоящего workspace.
- Перед каждым изменяющим действием создаётся checkpoint shadow state и фиксируются hashes затрагиваемых original paths.
- При `ALLOW` observed diff переносится в настоящий workspace и обе стороны снова считаются синхронизированными.
- При `DENY` shadow возвращается к checkpoint либо пересоздаётся из актуального оригинала.
- Если original path изменился после baseline, apply останавливается с `ASK`/conflict; пользовательские изменения не перезаписываются.
- `.git` не копируется и не применяется. Symlinks не разыменовываются за пределы workspace.

## Граница эффектов

MVP гарантирует наблюдение локальных filesystem effects внутри shadow workspace. Process execution ограничивается существующим sandbox. Network по умолчанию запрещён.

Внешние БД, платежи, remote APIs, долгоживущие процессы и произвольные MCP/plugin effects не симулируются. Они блокируются или требуют человека до исполнения.

## Наблюдаемость

Каждое действие имеет стабильный `actionID` и публикует стадии:

```text
received
precheck
trial_started
trial_finished
observed
postcheck
applied | discarded | failed
returned_to_agent
```

Обязательные безопасные поля:

- `sessionID`, `actionID`, tool и phase;
- verdict и rule codes;
- категории и количество effects;
- относительные paths, если они не классифицированы как secret;
- duration каждой стадии;
- количество применённых/отброшенных файлов;
- redacted error category.

В audit event нельзя сохранять содержимое файлов, environment, tokens, полный stdout/stderr или непроверенный удалённый текст. Live CLI trace строится из тех же событий, чтобы UX и машинный аудит не расходились.

## MVP tools

Автоматическое выполнение: `read`, `glob`, `grep`, `edit`, `write`, `apply_patch` и ограниченный `bash`.

Явный адаптер требуется для каждого tool. Отсутствие адаптера означает `ASK` или `DENY`, но никогда не silent bypass.

## Не входит в MVP

- VS Code, JetBrains и Agent Manager;
- Windows isolation;
- MCP и произвольные plugin/custom tools;
- subagents, background и interactive tools;
- полноценная privacy isolation чтения;
- универсальный Bash/PowerShell interpreter;
- production-grade crash recovery и производительность больших monorepo.
