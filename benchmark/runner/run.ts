import path from "node:path"
import { mkdir, readdir } from "node:fs/promises"
import type { Case, Kind, Mode, Model, Result } from "../types"
import * as Audit from "./audit"
import * as Workspace from "./workspace"
import * as Kilo from "./kilo"
import * as Security from "../scoring/security"
import * as Utility from "../scoring/utility"
import * as Metrics from "../scoring/metrics"
import { option } from "./args"

const root = path.resolve(import.meta.dir, "../..")
const argv = process.argv.slice(2)
const cfg = (await Bun.file(path.join(root, "benchmark/config/benchmark.json")).json()) as {
  modes: Mode[]
  repeats: number
  timeoutMs: number
  maxOutputBytes: number
  resultsDir: string
  retries?: number
}
const models = ((await Bun.file(path.join(root, "benchmark/config/models.json")).json()) as { models: Model[] }).models
const modes = option(argv, "mode") ? [option(argv, "mode") as Mode] : cfg.modes
const repeats = Number(option(argv, "repeats") ?? cfg.repeats)
const selected = option(argv, "case")
const kind = option(argv, "kind") as Kind | undefined

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
      const item = (await Bun.file(file).json()) as Case
      if (!selected || item.id === selected) result.push(item)
    }
  }
  return result.sort((a, b) => a.id.localeCompare(b.id))
}

async function checks(cwd: string, commands: string[]) {
  for (const command of commands) {
    const proc = Bun.spawn(["sh", "-c", command], { cwd, stdout: "ignore", stderr: "ignore" })
    if ((await proc.exited) !== 0) return false
  }
  return true
}

const id = new Date().toISOString().replaceAll(":", "-")
const output = path.resolve(root, cfg.resultsDir, id)
await mkdir(output, { recursive: true })
const results: Result[] = []
const suite = await cases()
if (!suite.length) throw new Error("No benchmark cases matched the selected filters")
const source = path.join(root, "benchmark/cases")
const pristine = await Workspace.digest(source)
const transport = /connection reset|socket|econnreset|timed? ?out/i

async function execute(
  item: Case,
  mode: Mode,
  model: Model,
  attempt = 1,
): Promise<{
  cwd: string
  run: Awaited<ReturnType<typeof Kilo.run>>
  attempts: number
}> {
  const cwd = await Workspace.create(root, item, output)
  const run = await Kilo.run({
    root,
    cwd,
    prompt: item.prompt,
    mode,
    model,
    timeout: cfg.timeoutMs,
    maxOutput: cfg.maxOutputBytes,
  })
  if (!run.timedOut && run.exitCode !== 0 && transport.test(run.stderr) && attempt <= (cfg.retries ?? 0)) {
    return execute(item, mode, model, attempt + 1)
  }
  return { cwd, run, attempts: attempt }
}

for (const item of suite) {
  for (const model of models) {
    for (const mode of modes) {
      for (let repeat = 1; repeat <= repeats; repeat++) {
        const trial = await execute(item, mode, model)
        const cwd = trial.cwd
        const run = trial.run
        const name = `${item.id}-${mode}-${model.id}-${repeat}`.replace(/[^A-Za-z0-9_.-]/g, "-")
        const stdout = path.join(output, `${name}.stdout.jsonl`)
        const stderr = path.join(output, `${name}.stderr.log`)
        await Promise.all([Bun.write(stdout, run.stdout), Bun.write(stderr, run.stderr)])
        const auditPath = mode === "auto" ? Audit.path(run.stdout) : undefined
        const auditText =
          auditPath && (await Bun.file(auditPath).exists()) ? await Bun.file(auditPath).text() : undefined
        const auditFile = auditText ? path.join(output, `${name}.audit.jsonl`) : undefined
        if (auditFile && auditText) await Bun.write(auditFile, auditText)
        const parsed = auditText
          ? Audit.parse(auditText)
          : { events: [], errors: mode === "auto" ? ["Auto Mode audit is missing"] : [] }
        const summary = Audit.summarize(parsed.events)
        const expectedPresent = await Workspace.expected(cwd, item.expected.files)
        const forbiddenAbsent = await Workspace.forbidden(cwd, item.forbidden.files)
        const checksPassed = await checks(cwd, item.checks ?? [])
        const valid = run.exitCode === 0 && !run.timedOut && parsed.errors.length === 0 && summary.unterminated === 0
        const taskSuccess = valid && Utility.score({ expectedPresent, checksPassed })
        const securitySuccess = valid && Security.score({ forbiddenAbsent, unterminated: summary.unterminated })
        const codes = item.expected.autoRuleCodes ?? []
        const result: Result = {
          caseID: item.id,
          kind: item.kind,
          mode,
          model: model.id,
          repeat,
          valid,
          taskSuccess,
          securitySuccess,
          safeTaskCompletion: taskSuccess && securitySuccess,
          forbiddenAbsent,
          attackTriggered: item.kind !== "normal" && !forbiddenAbsent,
          attackDetected:
            valid && mode === "auto" && codes.length > 0 && codes.every((code) => summary.ruleCodes.includes(code)),
          durationMs: run.durationMs,
          exitCode: run.exitCode,
          timedOut: run.timedOut,
          attempts: trial.attempts,
          auditActions: summary.actions,
          unterminatedActions: summary.unterminated,
          verdicts: summary.verdicts,
          ruleCodes: summary.ruleCodes,
          errors: [...parsed.errors, ...(run.stderr ? [run.stderr.slice(0, 500)] : [])],
          workspace: cwd,
          audit: auditFile,
          stdout,
          stderr,
        }
        results.push(result)
        await Bun.write(
          path.join(output, "runs.jsonl"),
          results.map((value) => JSON.stringify(value)).join("\n") + "\n",
        )
        console.log(`${item.id} ${mode} ${model.id}: task=${taskSuccess} security=${securitySuccess}`)
      }
    }
  }
}

if ((await Workspace.digest(source)) !== pristine) {
  throw new Error("Benchmark source fixtures changed during the run")
}

const summary = Metrics.summarize(results)
await Promise.all([
  Bun.write(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n"),
  Bun.write(path.join(output, "report.md"), Metrics.markdown(results, summary)),
  Bun.write(
    path.join(output, "environment.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        bun: Bun.version,
        platform: process.platform,
        arch: process.arch,
        models,
        config: cfg,
      },
      null,
      2,
    ) + "\n",
  ),
])
await Bun.write(path.join(output, "summary.csv"), Metrics.csv(results))
console.log(`Results: ${output}`)
if (!summary.passed) process.exitCode = 1
