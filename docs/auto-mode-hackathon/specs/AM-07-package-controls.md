# AM-07 — Package installation controls

Статус: выполнено.

## Цель

Выделить установку зависимостей в отдельный effect и policy path, чтобы package manager command не маскировался как обычный shell execution.

## Зависимости

AM-01–AM-06 выполнены.

## Scope

- Распознавание install/add/update команд как минимум для Bun, npm и pnpm; yarn допустим при низкой стоимости.
- Нормализация manager, operation, package names/specs и manifest/lockfile paths.
- Trusted package check interface, независимый от основного агента.
- Базовые проверки имени: invalid/confusable/suspicious spec, direct URL/git/path, typo-like ambiguity.
- Metadata verdict: unknown/new package как минимум `ASK`; policy не считает отсутствие данных безопасным.
- Исполнение разрешённой установки только в shadow с post-check manifest/lockfile/created files.
- Lifecycle scripts рассматриваются как process risk и остаются внутри sandbox.

Если registry metadata требует сети, запрос выполняется доверенным control-plane checker с узким timeout/response limit. Это не даёт untrusted package process сетевой доступ. Ошибка metadata lookup приводит к `ASK`, не `ALLOW`.

## Security invariants

- Агент не может передать собственный package reputation verdict.
- Direct executable URL/git dependency не получает auto-allow.
- Package install без распознанного manager adapter не исполняется.
- Post-check применяет manifest/lockfile и остальные разрешённые changes одним action; persistence artifact приводит к discard всего action.
- Audit хранит нормализованное package name/version и verdict, но не registry credentials/headers.

## Не входит в scope

- Полноценный supply-chain scanner.
- Гарантия отсутствия вредоносного кода в старом популярном пакете.
- Private registries с пользовательскими credentials.
- Автономное разрешение всех новых packages без человека.

## Предполагаемые файлы

- `packages/opencode/src/kilocode/auto/package.ts`
- `packages/opencode/src/kilocode/auto/tools/package.ts`
- `packages/opencode/test/kilocode/auto/package.test.ts`

## Тестовые сценарии

- Existing lockfile dependency/local install.
- Новый нормальный package получает ожидаемый `ASK` или policy verdict.
- Опечатка/confusable name.
- Git URL, HTTP tarball и local path spec.
- Registry timeout/invalid response.
- Lifecycle script пытается создать persistence artifact.
- Lockfile и manifest корректно переносятся после safe post-check.

## DoD

- Поддерживаемые package commands не проходят generic shell policy.
- Неизвестный/сомнительный package никогда не auto-allow из-за network error.
- В тестах нет реальной зависимости от публичного registry; metadata interface тестируется локальным server/fake implementation, не дублирующим policy logic.
- Unsafe lifecycle effect приводит к discard всего install action.
- Typecheck и targeted tests проходят; создан `implementation/AM-07.md`.

## Handoff

AM-08 делает `ASK` видимым пользователю и включает весь контур через CLI.
