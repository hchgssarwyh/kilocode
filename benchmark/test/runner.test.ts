import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Result } from "../types"
import { option } from "../runner/args"
import * as Audit from "../runner/audit"
import * as Kilo from "../runner/kilo"
import * as Metrics from "../scoring/metrics"
import * as Workspace from "../runner/workspace"

const roots: string[] = []
const command = process.env.KILO_BENCH_COMMAND

async function temp() {
  const root = await mkdtemp(path.join(os.tmpdir(), "kilo-benchmark-"))
  roots.push(root)
  return root
}

afterEach(async () => {
  if (command == null) delete process.env.KILO_BENCH_COMMAND
  else process.env.KILO_BENCH_COMMAND = command
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("Auto Mode benchmark runner", () => {
  test("does not treat another flag as the value of an absent option", () => {
    const argv = ["--case", "normal-edit", "--mode", "auto"]
    expect(option(argv, "case")).toBe("normal-edit")
    expect(option(argv, "mode")).toBe("auto")
    expect(option(argv, "kind")).toBeUndefined()
  })

  test("launches both modes autonomously in the isolated workspace", async () => {
    const root = await temp()
    const cwd = await temp()
    const script = path.join(root, "cli.sh")
    await writeFile(script, '#!/bin/sh\nprintf \'%s\\n\' "$PWD" "$(pwd)" "$*"\n')
    await chmod(script, 0o755)
    process.env.KILO_BENCH_COMMAND = script
    const model = { id: "test", model: "provider/model" }

    const baseline = await Kilo.run({
      root,
      cwd,
      prompt: "task",
      mode: "baseline",
      model,
      timeout: 5_000,
      maxOutput: 10_000,
    })
    const auto = await Kilo.run({ root, cwd, prompt: "task", mode: "auto", model, timeout: 5_000, maxOutput: 10_000 })

    expect(baseline.exitCode).toBe(0)
    expect(baseline.stdout.split("\n").slice(0, 2)).toEqual([cwd, cwd])
    expect(baseline.stdout).toContain(`run --auto --dir ${cwd} --format json --model provider/model task`)
    expect(baseline.stdout).not.toContain("--auto-mode")
    expect(auto.stdout).toContain("--auto-mode")
  })

  test("reads top-level verdicts from the audit of record", () => {
    const output = [
      JSON.stringify({ actionID: "one", phase: "precheck", verdict: "DENY", ruleCodes: ["AUTO_PERSISTENCE_PATH"] }),
      JSON.stringify({ actionID: "one", phase: "discarded", verdict: "DENY", ruleCodes: ["AUTO_PERSISTENCE_PATH"] }),
      JSON.stringify({ actionID: "one", phase: "returned_to_agent", ruleCodes: [] }),
    ].join("\n")
    const parsed = Audit.parse(output)
    expect(parsed.errors).toEqual([])
    expect(Audit.summarize(parsed.events)).toEqual({
      actions: 1,
      unterminated: 0,
      verdicts: { ALLOW: 0, ASK: 0, DENY: 2 },
      ruleCodes: ["AUTO_PERSISTENCE_PATH"],
    })
    expect(Audit.path('{"type":"auto_mode_summary","summary":{"audit":"/tmp/audit.jsonl"}}\n')).toBe("/tmp/audit.jsonl")
  })

  test("fingerprints source fixtures independently of copied workspaces", async () => {
    const root = await temp()
    await writeFile(path.join(root, "fixture.txt"), "clean")
    const clean = await Workspace.digest(root)
    const copy = await temp()
    await writeFile(path.join(copy, "fixture.txt"), "changed")
    expect(await Workspace.digest(root)).toBe(clean)
    await writeFile(path.join(root, "fixture.txt"), "changed")
    expect(await Workspace.digest(root)).not.toBe(clean)
  })

  test("reports validity and attack effectiveness separately", () => {
    const result = (mode: "baseline" | "auto", attackTriggered: boolean, securitySuccess: boolean): Result => ({
      caseID: "attack",
      kind: "attack",
      tags: ["persistence"],
      mode,
      model: "test",
      repeat: 1,
      valid: true,
      taskSuccess: true,
      securitySuccess,
      safeTaskCompletion: securitySuccess,
      forbiddenAbsent: !attackTriggered,
      attackTriggered,
      attackDetected: mode === "auto" && securitySuccess,
      durationMs: 1,
      exitCode: 0,
      timedOut: false,
      attempts: 1,
      auditActions: 1,
      unterminatedActions: 0,
      verdicts: { ALLOW: 0, ASK: 0, DENY: 1 },
      ruleCodes: ["AUTO_PERSISTENCE_PATH"],
      errors: [],
      workspace: "/tmp/workspace",
      stdout: "/tmp/stdout",
      stderr: "/tmp/stderr",
    })
    const summary = Metrics.summarize([result("baseline", true, false), result("auto", false, true)])
    expect(summary.passed).toBe(true)
    expect(summary.attacks).toEqual({ baselineTriggeredRate: 1, autoDetectionRate: 1, demonstratedPairRate: 1 })
    expect(Metrics.markdown([result("baseline", true, false), result("auto", false, true)], summary)).toContain(
      "Auto Mode safe-task completion: 100%",
    )
    expect(
      Metrics.markdown([result("baseline", true, false)], Metrics.summarize([result("baseline", true, false)])),
    ).toContain("COMPROMISED")
  })
})
