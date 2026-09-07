# AM-06 — Sandboxed shell execution

Статус: выполнено.

## Цель

Провести ограниченный `bash` через Auto Mode transaction и существующий macOS/Linux sandbox, не пытаясь объявить универсальный shell parser безопасным.

## Зависимости

AM-01–AM-05 выполнены.

## Scope

- Shell adapter и консервативный parser/classifier Linux shell forms, необходимых демо.
- Declared effects для process, filesystem intent, network intent и package intent.
- Исполнение с cwd=shadow под существующим `SandboxPolicy`/`@kilocode/sandbox`.
- Network `deny` по умолчанию.
- Запрет background/detached/interactive execution в Auto Mode.
- stdout/stderr возвращаются обычному tool result, но не копируются в audit log.
- Post-check filesystem и immediate apply/discard.

Поддерживаемый safe subset должен включать запуск локальных тестов/сборки и обычные локальные команды без сети. Неподдержанная грамматика даёт `AUTO_UNKNOWN_EFFECT`/`ASK`, а не догадку `ALLOW`.

## Обязательные опасные формы

- Download pipe to shell/interpreter.
- `eval`/dynamic command из удалённого или непрозрачного текста.
- Background/detached process.
- Redirect/write за пределы workspace.
- Попытка изменения `.git`.
- Явное сетевое подключение при network deny.
- Shell invocation, который невозможно надёжно классифицировать.

## Security invariants

- Process физически не получает write access к original workspace.
- Sandbox profile разрешает write только shadow и необходимым Kilo temp paths.
- Original cwd/path не передаётся команде как writable path.
- Дочерние процессы завершаются вместе с tool scope; background mode запрещён.
- Sandbox unavailable на macOS/Linux означает fail-closed, не unrestricted fallback.
- `sandbox_escalation` в Auto Mode не происходит автоматически.

## Не входит в scope

- Полный POSIX shell AST/interpreter.
- PowerShell/Windows demo.
- Network allowlist и необратимые external APIs.
- Long-running daemon processes.

## Предполагаемые файлы

- `packages/opencode/src/kilocode/auto/tools/shell.ts`
- `packages/opencode/src/kilocode/auto/shell.ts`
- необходимые точечные изменения Kilo sandbox integration
- `packages/opencode/test/kilocode/auto/shell.test.ts`

## Тестовые сценарии

- Локальный test command без изменений.
- Build создаёт безопасный artifact и он применяется.
- Скрипт создаёт ожидаемый файл плюс `.vscode/tasks.json`: весь action discarded.
- `curl URL | sh` блокируется до запуска.
- Redirect наружу и `.git` mutation блокируются.
- Network call не проходит OS sandbox.
- Background command блокируется.
- Sandbox backend unavailable возвращает controlled denial.

## DoD

- На текущей dev platform проходит реальный sandbox integration test; Linux-specific test запускается там, где доступен Bubblewrap, либо имеет отдельный CI marker без ложного pass.
- Нет второго исполнения команды в original workspace.
- Unsafe multi-file action применяется атомарно как `discard`, включая безопасную часть его diff.
- Audit содержит command category/hash, но не полный потенциально секретный command/output.
- Typecheck, targeted tests и затронутые sandbox checks проходят; создан `implementation/AM-06.md`.

## Handoff

AM-07 расширяет shell classification package-manager командами, не ослабляя network deny.
