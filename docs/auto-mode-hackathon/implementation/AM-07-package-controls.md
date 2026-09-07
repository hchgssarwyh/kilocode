# AM-07 — Package installation controls

Статус: complete
Commit/ветка: `b391948e61` / `main` (изменения в working tree, отдельный commit не создавался)

## Что сделано

- Package-команды Bun, npm, pnpm и yarn выделены из generic shell execution в нормализованные `package.install` effects; учтены операции install/add/update/remove, `npm ci`, короткие aliases, implicit yarn install и запуск pnpm через corepack.
- Нормализуются manager, operation, package name/spec, ближайший `package.json` и manager-specific lockfile paths.
- Добавлен независимый trusted metadata checker, который передаётся только через `Gateway.activate`; checker получает manager/name и ограниченный `AbortSignal`, но не agent metadata, registry credentials или command text.
- Локальная проверка отличает уже объявленную dependency/local lockfile install от новой. Existing dependency может получить `ALLOW`; new, unknown, timeout и invalid metadata response получают `ASK`.
- Invalid/confusable names, npm aliases, direct URL/git/path specs и typo/mismatched canonical metadata остаются suspicious и никогда не получают auto-allow.
- Неподдерживаемые package managers получают `AUTO_PACKAGE_MANAGER_UNSUPPORTED` и `DENY` до запуска.
- Package process сохраняет shell `process.exec`, поэтому выполняется один раз в существующем shadow и принудительном OS sandbox с `network: deny`. Manifest, lockfile и остальные созданные файлы проходят общий observed post-check и применяются одной транзакцией.
- Audit event дополнен безопасными нормализованными package metadata и manifest/lockfile paths без raw URL, headers или credentials.

## Фактическая архитектура

- `Package.classify` в `packages/opencode/src/kilocode/auto/package.ts` является чистым command adapter. `Shell.classify` добавляет его effects к существующему `process.exec`, не создавая отдельный execution wrapper.
- `Package.assess` асинхронно ищет ближайший manifest внутри trusted workspace root, проверяет dependency groups и lockfile, затем при необходимости вызывает инъецированный `Package.Checker`. Timeout ограничен 5 секундами сверху; exception, timeout и Schema-invalid ответ преобразуются в status `unknown`.
- `Adapter.assess` вызывается Gateway до pre-policy. Agent/tool args не содержат способа передать checker verdict; доверенная dependency доступна только session activation host-коду.
- `Rules.registry` разрешает `package.install` только со status `existing`, требует review для остальных status и отдельно запрещает `unsupported` manager.
- Trial/apply path не менялся: bash получает shadow workdir, AM-06 `SandboxPolicy.executeAuto` сохраняет физический network deny, а `Workspace.transaction` атомарно применяет или отбрасывает полный observed effect set.

## Изменённые файлы

- `packages/opencode/src/kilocode/auto/package.ts`
- `packages/opencode/src/kilocode/auto/types.ts`
- `packages/opencode/src/kilocode/auto/shell.ts`
- `packages/opencode/src/kilocode/auto/adapter.ts`
- `packages/opencode/src/kilocode/auto/gateway.ts`
- `packages/opencode/src/kilocode/auto/rules.ts`
- `packages/opencode/src/kilocode/auto/event.ts`
- `packages/opencode/src/kilocode/auto/audit.ts`
- `packages/opencode/test/kilocode/auto/package.test.ts`
- `packages/opencode/test/kilocode/auto/audit.test.ts`
- `packages/opencode/test/kilocode/auto/policy.test.ts`
- `docs/auto-mode-hackathon/specs/AM-07-package-controls.md`
- `docs/auto-mode-hackathon/specs/README.md`
- `docs/auto-mode-hackathon/implementation/AM-07.md`

## Проверки и результаты

- `cd packages/opencode && /Users/hchgssarwyh/.bun/bin/bun run typecheck` — успешно.
- `cd packages/opencode && /Users/hchgssarwyh/.bun/bin/bun test ./test/kilocode/auto/audit.test.ts ./test/kilocode/auto/policy.test.ts ./test/kilocode/auto/observe.test.ts ./test/kilocode/auto/workspace.test.ts ./test/kilocode/auto/gateway.test.ts ./test/kilocode/auto/shell.test.ts ./test/kilocode/auto/package.test.ts` — 79 pass, 1 platform-conditional skip, 0 fail.
- `cd packages/opencode && /Users/hchgssarwyh/.bun/bin/bun test ./test/kilocode/auto/package.test.ts ./test/kilocode/auto/audit.test.ts ./test/kilocode/auto/policy.test.ts` — 49 pass, 0 fail.
- `cd packages/opencode && /Users/hchgssarwyh/.bun/bin/bunx prettier --check ...` — успешно для затронутых TypeScript-файлов.
- `bun run script/check-opencode-annotations.ts --worktree` — успешно.
- `bun run script/check-opencode-promise-facades.ts` — успешно.
- `bun run script/check-md-table-padding.ts` — успешно.
- `git diff --check` — успешно.

## Отклонения от ТЗ

- Yarn реализован вместе с обязательными Bun/npm/pnpm, поскольку использует тот же небольшой адаптер.
- Реальный registry client намеренно не добавлен: AM-07 определяет и проверяет trusted checker boundary локальной fake implementation. Без host-provided checker новая dependency остаётся `unknown`/`ASK`, что соответствует fail-closed контракту и исключает зависимость тестов от публичного registry.
- Отдельный `tools/package.ts` не понадобился: package manager уже исполняется инструментом `bash`, а вся Kilo-specific классификация и metadata boundary находятся в `auto/package.ts`.
- Changeset не добавлялся, поскольку Auto Mode ещё не активируется пользователем до AM-08 и эта часть сама по себе не меняет доступное CLI-поведение.

## Известные ограничения

- Проверка existing dependency подтверждает только наличие имени в manifest либо local install с существующим lockfile; это не supply-chain/reputation scanner и не доказывает безопасность версии.
- Package manager может использовать разрешённые существующим sandbox Kilo-owned cache/temp paths. Изменения project manifest, lockfile, dependency tree и lifecycle outputs происходят в shadow и наблюдаются; production-grade аудит package-manager cache не входит в MVP.
- Private registries и передача пользовательских registry credentials не поддерживаются. Checker получает только нормализованные manager/name.
- Полный синтаксис package managers не моделируется. Неизвестные wrappers остаются под AM-06 shell classifier и физическим network deny; explicit Bun/npm/pnpm/yarn install forms покрыты adapter tests.

## Handoff следующему агенту

AM-08 должен передавать trusted checker в `Gateway.activate` только из host control plane либо оставить его отсутствующим, при этом new/unknown packages обязаны показывать `ASK`. CLI trace следует строить из `AuditEvent.packages`, не из raw bash args. Нельзя ослаблять AM-06 `network: deny` для package process и нельзя превращать metadata lookup failure в `ALLOW`.
