# Части ТЗ

Статус: согласованная последовательная декомпозиция MVP. Задачи выполняются по порядку; агент перед началом читает target architecture, свою задачу и implementation reports предыдущих задач.

| ID | Часть | Предварительный результат | Статус |
|---|---|---|---|
| AM-01 | Domain и audit protocol | Типы, события и redaction contract | Выполнено |
| AM-02 | Deterministic policy | Две фазы verdict и rule codes | Выполнено |
| AM-03 | Filesystem observer | Security manifest и observed diff | Выполнено |
| AM-04 | Shadow workspace | Session shadow, checkpoint, apply/discard | Выполнено |
| AM-05 | Execution gateway | Обязательный перехват и file tool adapters | Выполнено |
| AM-06 | Sandboxed shell | Shell adapter, process/network ограничения | Выполнено |
| AM-07 | Package controls | Package effects и install policy | Выполнено |
| AM-08 | Activation и CLI trace | `--auto-mode`, live trace и summary | Выполнено |
| AM-09 | E2E, атаки и метрики | Демо-набор, regression tests и handoff | Выполнено |

Файлы задач:

1. `AM-01-domain-audit.md`
2. `AM-02-policy.md`
3. `AM-03-observer.md`
4. `AM-04-shadow-workspace.md`
5. `AM-05-gateway-file-tools.md`
6. `AM-06-shell-sandbox.md`
7. `AM-07-package-controls.md`
8. `AM-08-cli-observability.md`
9. `AM-09-e2e-demo.md`

После выполнения каждой части:

- создать `implementation/AM-NN.md` по шаблону;
- поменять статус строки на `Выполнено`;
- выполнить минимальные проверки из `packages/opencode/AGENTS.md`;
- не начинать следующую часть при красных тестах, вызванных текущей частью.
