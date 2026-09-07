// Оценка частоты срабатывания политики Auto Mode на корпусе реальных действий агентов.
// Запуск (WSL): cp в ~/kilocode/packages/opencode/script/kilocode/corpus-eval.ts и
//   bun run --cwd ~/kilocode/packages/opencode script/kilocode/corpus-eval.ts <actions.jsonl> [label]
// Вход: JSONL с полем "action" (SWE-agent) или "command" (готовая shell-команда).
// Выход: JSON-сводка в stdout. Текст команд в сводку не попадает целиком — только первые 100 символов примеров.
import { Adapter } from "../../src/kilocode/auto/adapter"
import { Policy } from "../../src/kilocode/auto/policy"

const file = process.argv[2]
const label = process.argv[3] ?? file
if (!file) throw new Error("usage: corpus-eval.ts <actions.jsonl> [label]")

// Специальные команды интерфейса SWE-agent: не shell, а аналоги инструментов read/edit.
const readCommands = new Set(["open", "goto", "scroll_up", "scroll_down", "search_dir", "search_file", "find_file"])
const editCommands = new Set(["edit", "create", "insert", "append"])
const skipCommands = new Set(["submit", "exit", "exit_context", "skip"])

type Bucket = { count: number; examples: string[] }
const verdicts: Record<string, number> = { ALLOW: 0, ASK: 0, DENY: 0 }
const codes: Record<string, Bucket> = {}
const kinds: Record<string, number> = { read: 0, edit: 0, bash: 0, skip: 0 }
const idioms: Record<string, number> = { "2>&1": 0, "2>/dev/null": 0, "$(": 0, "|": 0, "&&": 0, "git": 0, "pip/npm install": 0, "curl/wget": 0 }
const multiline = { count: 0 }

function bucket(code: string, command: string) {
  const entry = (codes[code] ??= { count: 0, examples: [] })
  entry.count++
  if (entry.examples.length < 6) entry.examples.push(command.split("\n")[0]!.slice(0, 100))
}

const lines = (await Bun.file(file).text()).split("\n").filter((line) => line.trim())
for (const line of lines) {
  const record = JSON.parse(line) as { action?: string; command?: string; instance?: string }
  const raw = (record.command ?? record.action ?? "").trim()
  if (!raw) continue
  // SWE-agent работает в /<repo>; instance_id вида "owner__repo-123" → корень "/repo".
  const repo = record.instance?.split("__").at(1)?.replace(/-\d+$/, "")
  const root = repo ? `/${repo}` : "/workspace"
  const head = raw.split(/\s+/)[0] ?? ""
  if (record.action !== undefined) {
    if (skipCommands.has(head)) {
      kinds.skip++
      continue
    }
    if (readCommands.has(head)) {
      kinds.read++
      continue
    }
    if (editCommands.has(head)) {
      kinds.edit++
      continue
    }
  }
  kinds.bash++
  if (raw.includes("\n")) multiline.count++
  if (raw.includes("2>&1")) idioms["2>&1"]++
  if (raw.includes("2>/dev/null")) idioms["2>/dev/null"]++
  if (raw.includes("$(")) idioms["$("]++
  if (/\|(?!\|)/.test(raw)) idioms["|"]++
  if (raw.includes("&&")) idioms["&&"]++
  if (/(^|\s|;|&&)git\s/.test(raw)) idioms.git++
  if (/\b(pip3?|npm|pnpm|yarn|bun)\s+(install|add|i)\b/.test(raw)) idioms["pip/npm install"]++
  if (/\b(curl|wget)\b/.test(raw)) idioms["curl/wget"]++

  const info = Adapter.resolve("bash", { command: raw }, root)
  const decision = Policy.evaluate({
    phase: "pre",
    tool: "bash",
    adapter: info.kind === "unsupported" ? "unsupported" : "supported",
    root,
    effects: info.effects,
  })
  verdicts[decision.verdict] = (verdicts[decision.verdict] ?? 0) + 1
  if (decision.ruleCodes.length === 0) bucket("ALLOW", raw)
  for (const code of decision.ruleCodes) bucket(code, raw)
}

const bash = kinds.bash || 1
const summary = {
  label,
  records: lines.length,
  kinds,
  bash: {
    total: kinds.bash,
    multiline: multiline.count,
    verdicts,
    shares: Object.fromEntries(Object.entries(verdicts).map(([k, v]) => [k, `${((100 * v) / bash).toFixed(1)}%`])),
    idioms,
  },
  codes: Object.fromEntries(
    Object.entries(codes)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([code, value]) => [code, { count: value.count, share: `${((100 * value.count) / bash).toFixed(1)}%`, examples: value.examples }]),
  ),
}
console.log(JSON.stringify(summary, null, 2))
