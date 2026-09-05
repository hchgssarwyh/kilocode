# AM-06 — Sandboxed shell execution

Статус: complete
Commit/ветка: `b391948e61` / `main` (изменения в working tree, отдельный commit не создавался)

## Что сделано

- `bash` подключён к общему Auto Mode Gateway как serializable mutation и исполняется один раз внутри shadow transaction.
- Добавлен консервативный classifier Linux shell subset с declared effects для process, явных filesystem mutations/redirections, network, package intent и background execution.
- Dynamic/control/неразобранные формы получают `unknown` и `ASK`; remote execution, background/detached формы, external writes, `.git` mutations и persistence paths получают детерминированный `DENY`.
- Для shell trial добавлен принудительный macOS/Linux sandbox profile с `network: deny`, writable shadow и явным `denyWrite` для original workspace.
- `workdir` всегда переписывается в соответствующий path внутри shadow; внешний `workdir` блокируется как unsupported.
- Command передаётся в audit только как SHA-256 fingerprint. stdout/stderr остаются в обычном agent-facing tool result и не попадают в audit payload.
- Post-policy принимает непредсказуемые безопасные build artifacts внутри shadow как filesystem effects объявленного `process.exec`, но продолжает применять правила persistence/Git/outside/unknown ко всему observed набору.

## Фактическая архитектура

- `classify` в `packages/opencode/src/kilocode/auto/shell.ts` использует небольшой fail-closed tokenizer, а не объявляет полный POSIX parser безопасным. Quotes и простые chains/pipes поддерживаются; expansions, command substitution, eval/interpreter snippets, shell control forms и opaque wrappers добавляют `unknown`.
- `Adapter.resolve` возвращает для `bash` kind `mutation`, поэтому Gateway использует тот же checkpoint → trial → observe → postcheck → apply/discard lifecycle, что и file tools.
- Gateway передаёт через внутренний `Tool.Context.extra` original/shadow roots. `SessionTools` выбирает `SandboxPolicy.executeAuto` только для такого trial; обычный shell вне Auto Mode сохраняет существующую session sandbox semantics.
- `SandboxPolicy.executeAuto` не читает пользовательский network mode и не допускает allow/proxy inheritance: backend обязан быть доступен, profile всегда `deny`, а original добавляется в deny rules даже когда workspace находится под системным temp root.
- `process.background` является отдельной категорией effect и правилом `AUTO_BACKGROUND_PROCESS`. Unavailable backend возвращает controlled `AutoModeSandboxUnavailable`, не выполняя effect без confinement.
- Audit event содержит deduplicated fingerprints, но не command text, args или output.

## Изменённые файлы

- `packages/opencode/src/kilocode/auto/shell.ts`
- `packages/opencode/src/kilocode/auto/adapter.ts`
- `packages/opencode/src/kilocode/auto/types.ts`
- `packages/opencode/src/kilocode/auto/rules.ts`
- `packages/opencode/src/kilocode/auto/event.ts`
- `packages/opencode/src/kilocode/auto/audit.ts`
- `packages/opencode/src/kilocode/auto/gateway.ts`
- `packages/opencode/src/kilocode/sandbox/policy.ts`
- `packages/opencode/src/session/tools.ts`
- `packages/opencode/test/kilocode/auto/audit.test.ts`
- `packages/opencode/test/kilocode/auto/gateway.test.ts`
- `packages/opencode/test/kilocode/auto/shell.test.ts`
- `docs/auto-mode-hackathon/specs/AM-06-shell-sandbox.md`
- `docs/auto-mode-hackathon/specs/README.md`
- `docs/auto-mode-hackathon/notes/decisions.md`
- `docs/auto-mode-hackathon/implementation/AM-06.md`

## Проверки и результаты

- `cd packages/opencode && /Users/hchgssarwyh/.bun/bin/bun run typecheck` — успешно.
- `cd packages/opencode && /Users/hchgssarwyh/.bun/bin/bun test ./test/kilocode/auto/audit.test.ts ./test/kilocode/auto/policy.test.ts ./test/kilocode/auto/observe.test.ts ./test/kilocode/auto/workspace.test.ts ./test/kilocode/auto/gateway.test.ts ./test/kilocode/auto/shell.test.ts` — 71 pass, 1 platform-conditional skip, 0 fail. На текущей macOS реальные Seatbelt tests запускались вне внешнего Codex sandbox, потому что macOS запрещает вложенный `sandbox-exec`.
- `cd packages/opencode && /Users/hchgssarwyh/.bun/bin/bun test ./test/kilocode/auto/shell.test.ts ./test/kilocode/sandbox/shell-network.test.ts` — 10 pass, 1 platform-conditional skip, 0 fail; проверены реальный process sandbox, original write denial и loopback network denial.
- `cd packages/opencode && /Users/hchgssarwyh/.bun/bin/bunx prettier --check ...` — успешно для затронутых TypeScript-файлов.
- `bun run script/check-opencode-annotations.ts --worktree` — успешно, shared upstream changes размечены `kilocode_change`.
- `bun run script/check-opencode-promise-facades.ts` — успешно, runtime drift не найден.
- `bun run script/check-md-table-padding.ts` — успешно, 402 Markdown-файла проверены.
- `git diff --check` — успешно.

## Отклонения от ТЗ

- Основной отчёт назван ровно `implementation/AM-06.md`, как требует DoD, хотя предыдущие задачи использовали slug в имени.
- Отдельный Linux integration run в текущей macOS-среде невозможен. Тесты используют `backendSupport`: реальные sandbox cases выполняются на доступном macOS/Linux backend, а unavailable-platform case имеет отдельный условный test без ложного успешного результата.

## Известные ограничения

- Classifier намеренно не является полным shell interpreter. Dynamic expansion, control flow, heredoc/input redirection и opaque wrappers требуют `ASK`; после разрешения они всё равно остаются внутри OS sandbox и проходят observed post-check.
- Список network/package/mutation executables консервативный и будет расширяться в AM-07. Неизвестный executable не получает сеть: физический `network: deny` действует независимо от классификации.
- Windows/PowerShell не поддерживаются и блокируются через unsupported adapter; Windows sandbox backend отсутствует.
- macOS не позволяет запускать реальный Seatbelt integration test из уже sandboxed test runner. Для локальной проверки требуется запуск вне внешнего sandbox; CI на Linux должен предоставить Bubblewrap.

## Handoff следующему агенту

AM-07 должен расширять `packageEffect`/shell classification через Kilo-owned adapter, не менять forced `network: deny` и не разрешать `sandbox_escalation`. Package-manager side effects должны оставаться внутри той же shadow transaction; lockfile/manifest changes применяются только после общего observed post-check.
