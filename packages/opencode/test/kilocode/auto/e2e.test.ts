import { afterEach, describe, expect, test } from "bun:test"
import { backendSupport } from "@kilocode/sandbox"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { demo } from "../../../script/kilocode/auto-mode-demo"
import { Metrics } from "../../../src/kilocode/auto/metrics"

const roots: string[] = []
const supported = backendSupport({ mode: "deny", allowedHosts: [] }).available

async function temp() {
  const root = await mkdtemp(path.join(os.tmpdir(), "kilo-auto-e2e-"))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("Auto Mode AM-09 demo", () => {
  test.skipIf(!supported)("runs every normal and attack scenario with real transactions and sandboxing", async () => {
    const root = await temp()
    const result = await demo(root, () => {})
    const audit = await readFile(result.audit, "utf8")
    const metrics = JSON.parse(await readFile(result.metrics, "utf8"))
    const events = Metrics.parse(audit)

    expect(result.cases).toHaveLength(6)
    expect(result.cases.every((item) => item.status === "passed")).toBe(true)
    expect(result.summary).toMatchObject({
      actions: 9,
      verdicts: { ALLOW: 4, ASK: 1, DENY: 4 },
      attacks: { expected: 5, detected: 5 },
      falsePositives: 0,
      unterminated: 0,
    })
    expect(result.summary.decisions).toEqual({
      pre: { ALLOW: 5, ASK: 1, DENY: 3 },
      post: { ALLOW: 3, ASK: 0, DENY: 1 },
    })
    expect(result.summary.durations.precheck.count).toBe(9)
    expect(result.summary.durations.trial.count).toBe(4)
    expect(result.summary.durations.observe.count).toBe(4)
    expect(result.summary.durations.policy.count).toBe(4)
    expect(result.summary.durations.apply.count).toBe(5)
    expect(metrics).toEqual(result.summary)
    expect(events.filter((event) => event.phase === "returned_to_agent")).toHaveLength(9)

    expect(await readFile(path.join(result.workspace, "src", "calc.ts"), "utf8")).toContain("a + b")
    expect(await readFile(path.join(result.workspace, "src", "notes.md"), "utf8")).toContain("safe project note")
    expect(await Bun.file(path.join(result.workspace, ".vscode", "tasks.json")).exists()).toBe(false)
    expect(await Bun.file(path.join(result.workspace, "artifact.txt")).exists()).toBe(false)
    expect(await Bun.file(path.join(result.workspace, "package-lock.json")).exists()).toBe(false)
    expect(audit).not.toContain("DEMO-HOSTILE-CONTENT-MUST-NOT-ENTER-AUDIT")
    expect(audit).not.toContain("persistence payload")
    expect(audit).not.toContain("curl https://")
  })

  test.skipIf(!supported)("starts clean and produces the same decision hash on repeated runs", async () => {
    const root = await temp()
    const first = await demo(root, () => {})
    const second = await demo(root, () => {})

    expect(first.dir).not.toBe(second.dir)
    expect(first.summary.decisionHash).toBe(second.summary.decisionHash)
    expect(second.summary.unterminated).toBe(0)
    expect(second.summary.falsePositives).toBe(0)
  })

  test("rejects malformed JSONL instead of reporting partial metrics", () => {
    expect(() => Metrics.parse('{"phase":"precheck"}\n')).toThrow()
    expect(() => Metrics.parse("not-json\n")).toThrow()
  })
})
