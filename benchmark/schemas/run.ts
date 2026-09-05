import path from "node:path"
import { mkdir, readdir } from "node:fs/promises"
import type { Case, Kind, Mode, Model, Result } from "../types"
import * as Audit from "./audit"
import * as Workspace from "./workspace"
import * as Kilo from "./kilo"
import * as Security from "../scoring/security"
import * as Utility from "../scoring/utility"
import * as Metrics from "../scoring/metrics"

const root = path.resolve(import.meta.dir, "../..")
const argv = process.argv.slice(2)
const option = (name: string) => argv.at(argv.indexOf(`--${name}`) + 1)
const cfg = await Bun.file(path.join(root, "benchmark/config/benchmark.json")).json() as { modes: Mode[]; repeats: number; timeoutMs: number; maxOutputBytes: number; resultsDir: string }
const models = (await Bun.file(path.join(root, "benchmark/config/models.json")).json() as { models: Model[] }).models
const modes = option("mode") ? [option("mode") as Mode] : cfg.modes
const repeats = Number(option("repeats") ?? cfg.repeats)
const selected = option("case")
const kind = option("kind") as Kind | undefined

if (modes.some((mode) => !["baseline", "auto"].includes(mode))) {
  throw new Error("--mode must be baseline or auto")
}
if (kind && !["normal", "attack", "mixed"].includes(kind)) {
  throw new Error("--kind must be normal, attack or mixed")
}
if (!Number.isInteger(repeats) || repeats < 1) {
  throw new Error("--repeats must be a positive integer")
}

async function cases() {
  const result: Case[] = []
  for (const group of ["normal", "attack", "mixed"] as const) {
    if (kind && group !== kind) continue
    const dir = path.join(root, "benchmark/cases", group)
    for (const name of await readdir(dir)) {
      const file = path.join(dir, name, "case.json")
      if (!(await Bun.file(file).exists())) continue
      const item = await Bun.file(file).json() as Case
      if (!selected || item.id === selected) result.push(item)
    }
  }
  return result.sort((a, b) => a.id.localeCompare(b.id))
}

async function checks(cwd: string, commands: string[]) {
  for (const command of commands) {
    const proc = Bun.spawn(["sh", "-c", command], { cwd, stdout: "ignore", stderr: "ignore" })
    if (await proc.exited !== 0) return false
  }
  return true
}

const id = new Date().toISOString().replaceAll(":", "-")
const output = path.resolve(root, cfg.resultsDir, id)
await mkdir(output, { recursive: true })
const results: Result[] = []
const suite = await cases()
if (!suite.length) throw new Error("No benchmark cases matched the selected filters")

for (const item of suite) {
  for (const model of models) {
    for (const mode of modes) {
      for (let repeat = 1; repeat <= repeats; repeat++) {
        const cwd = await Workspace.create(root, item, output)
        const run = await Kilo.run({ root, cwd, prompt: item.prompt, mode, model, timeout: cfg.timeoutMs, maxOutput: cfg.maxOutputBytes })
        const parsed = mode === "auto" ? Audit.parse(run.stdout) : { events: [], errors: [] }
        const audit = Audit.summarize(parsed.events)
        const expectedPresent = await Workspace.expected(cwd, item.expected.files)
        const forbiddenAbsent = await Workspace.forbidden(cwd, item.forbidden.files)
        const checksPassed = await checks(cwd, item.checks ?? [])
        const taskSuccess = Utility.score({ expectedPresent, checksPassed })
        const securitySuccess = Security.score({ item, mode, forbiddenAbsent, codes: audit.ruleCodes, unterminated: audit.unterminated })
        const result: Result = {
          caseID: item.id, kind: item.kind, mode, model: model.id, repeat,
          taskSuccess, securitySuccess, safeTaskCompletion: taskSuccess && securitySuccess,
          durationMs: run.durationMs, exitCode: run.exitCode, auditActions: audit.actions,
          unterminatedActions: audit.unterminated, verdicts: audit.verdicts, ruleCodes: audit.ruleCodes,
          errors: [...parsed.errors, ...(run.stderr ? [run.stderr.slice(0, 500)] : [])], workspace: cwd,
        }
        results.push(result)
        await Bun.write(path.join(output, "runs.jsonl"), results.map((value) => JSON.stringify(value)).join("\n") + "\n")
        console.log(`${item.id} ${mode} ${model.id}: task=${taskSuccess} security=${securitySuccess}`)
      }
    }
  }
}

await Bun.write(path.join(output, "summary.json"), JSON.stringify(Metrics.summarize(results), null, 2) + "\n")
await Bun.write(path.join(output, "summary.csv"), Metrics.csv(results))
console.log(`Results: ${output}`)
