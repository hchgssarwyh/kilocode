import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { AutoModeCLI } from "../../../src/kilocode/cli/auto-mode"
import * as Audit from "../../../src/kilocode/auto/audit"
import { AutoModeEvent } from "../../../src/kilocode/auto/event"
import { createActionID, type Action } from "../../../src/kilocode/auto/types"
import { SessionID } from "../../../src/session/schema"

const roots: string[] = []

async function temp() {
  const root = await mkdtemp(path.join(os.tmpdir(), "kilo-auto-cli-"))
  roots.push(root)
  return root
}

const sessionID = SessionID.make("ses_auto_cli_test")

function action(path: string): Action {
  const callID = "call-auto-cli"
  return {
    sessionID,
    callID,
    actionID: createActionID({ sessionID, callID }),
    tool: "write",
    effects: [{ category: "file.write", path }],
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("Auto Mode CLI observability", () => {
  test("fails preflight when the forced deny-network backend is unavailable", () => {
    let network: unknown
    expect(() =>
      AutoModeCLI.preflight((value) => {
        network = value
        return { available: false, reason: "sandbox missing" }
      }),
    ).toThrow("sandbox missing")
    expect(network).toEqual({ mode: "deny", allowedHosts: [] })
  })

  test("distinguishes human policy review from an approved trial permission", () => {
    expect(AutoModeCLI.permission({ metadata: { autoMode: true } }, false)).toBeUndefined()
    expect(AutoModeCLI.permission({ metadata: { autoModeTrial: true } }, true)).toBe("trial")
    expect(AutoModeCLI.permission({ metadata: { autoMode: true, autoModeTrial: true } }, true)).toBe("review")
  })

  test("writes redacted JSONL, renders safe trace, and derives summary from events", async () => {
    const root = await temp()
    const handle = await AutoModeCLI.create({ sessionID, dir: path.join(root, "audit") })
    const token = "ghp_SUPER_SECRET_TOKEN_123456"
    const current = action(".env.production")
    const inputs: Audit.Input[] = [
      { action: current, phase: "received", timestamp: 1 },
      {
        action: current,
        phase: "precheck",
        timestamp: 2,
        decision: {
          phase: "pre",
          verdict: "DENY",
          ruleCodes: ["AUTO_PERSISTENCE_PATH"],
          summary: `blocked ${token}`,
        },
        secrets: { token },
      },
      {
        action: current,
        phase: "discarded",
        timestamp: 3,
        decision: {
          phase: "pre",
          verdict: "DENY",
          ruleCodes: ["AUTO_PERSISTENCE_PATH"],
          summary: "blocked",
        },
        counts: { discarded: 1 },
      },
      { action: current, phase: "returned_to_agent", timestamp: 4 },
    ]

    for (const input of inputs) await handle.record(input)
    const event = Audit.redact(inputs.at(1)!)
    expect(handle.render(event)).toBe("AUTO #a1 write [secret path] pre DENY AUTO_PERSISTENCE_PATH")
    expect(AutoModeCLI.parse({ type: AutoModeEvent.Action.type, properties: event }, sessionID)).toEqual(event)
    expect(AutoModeCLI.parse({ type: AutoModeEvent.Action.type, properties: event }, "ses_other")).toBeUndefined()

    const summary = handle.summary()
    expect(summary).toMatchObject({ actions: 1, applied: 0, denied: 1, asked: 0, protected: 1 })
    expect(AutoModeCLI.summary(summary)).toEqual([
      "Auto Mode: 1 actions, 0 applied, 1 denied, 0 asked",
      "Protected: 1 unsafe filesystem action discarded",
      `Audit: ${handle.path}`,
    ])

    await handle.close()
    const text = await readFile(handle.path, "utf8")
    const lines = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(lines).toHaveLength(inputs.length)
    expect(lines.every((line) => line.sessionID === sessionID)).toBe(true)
    expect(text).not.toContain(token)
    expect(text).not.toContain(".env.production")
    expect((await stat(handle.path)).mode & 0o777).toBe(0o600)
  })

  test("counts ASK once and keeps JSON event output machine-readable", async () => {
    const root = await temp()
    const handle = await AutoModeCLI.create({ sessionID, dir: root })
    const current = action("src/index.ts")
    const decision = {
      phase: "post" as const,
      verdict: "ASK" as const,
      ruleCodes: ["AUTO_EFFECT_MISMATCH"] as const,
      summary: "Review required",
    }
    await handle.record({ action: current, phase: "postcheck", timestamp: 1, decision })
    await handle.record({ action: current, phase: "discarded", timestamp: 2, decision, counts: { discarded: 1 } })

    expect(handle.summary()).toMatchObject({ actions: 1, applied: 0, denied: 0, asked: 1, protected: 1 })
    const event = Audit.redact({ action: current, phase: "postcheck", timestamp: 1, decision })
    expect(() => JSON.stringify({ type: "auto_mode", event })).not.toThrow()
    await handle.close()
  })
})
