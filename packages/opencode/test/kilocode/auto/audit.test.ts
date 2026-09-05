import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { AuditEvent, AutoModeEvent } from "../../../src/kilocode/auto/event"
import { redact, serialize, type Input } from "../../../src/kilocode/auto/audit"
import {
  Action,
  ActionEffect,
  AuditPhase,
  Decision,
  createActionID,
  type Action as AutoAction,
  type ActionEffectCategory,
  type AuditPhase as AutoAuditPhase,
} from "../../../src/kilocode/auto/types"
import { SessionID } from "../../../src/session/schema"

const sessionID = SessionID.make("ses_auto_mode_audit_test")

function action(effects: AutoAction["effects"] = []): AutoAction {
  const callID = "call-audit-1"
  return {
    actionID: createActionID({ sessionID, callID }),
    sessionID,
    callID,
    tool: "write",
    effects,
  }
}

describe("Auto Mode domain", () => {
  test("accepts every required action effect category", () => {
    const categories: ActionEffectCategory[] = [
      "file.read",
      "file.write",
      "file.delete",
      "file.symlink",
      "process.exec",
      "process.background",
      "network.connect",
      "package.install",
      "persistence.create",
      "unknown",
    ]

    for (const category of categories) {
      expect(Schema.decodeUnknownSync(ActionEffect)({ category }).category).toBe(category)
    }
  })

  test("requires rule codes for ASK and DENY decisions", () => {
    const decode = Schema.decodeUnknownSync(Decision)
    expect(() => decode({ phase: "pre", verdict: "ASK", ruleCodes: [], summary: "Needs review" })).toThrow()
    expect(() => decode({ phase: "post", verdict: "DENY", ruleCodes: [], summary: "Blocked" })).toThrow()
    expect(
      decode({ phase: "pre", verdict: "ASK", ruleCodes: ["AUTO_UNKNOWN_EFFECT"], summary: "Needs review" }),
    ).toBeDefined()
    expect(decode({ phase: "post", verdict: "ALLOW", ruleCodes: [], summary: "Safe" })).toBeDefined()
  })

  test("derives a stable action ID from one session and tool call", () => {
    const first = createActionID({ sessionID, callID: "call-1" })
    const second = createActionID({ sessionID, callID: "call-1" })
    const other = createActionID({ sessionID, callID: "call-2" })

    expect(first).toBe(second)
    expect(first).not.toBe(other)
    expect(() => createActionID({ sessionID, callID: "" })).toThrow()
    expect(Schema.decodeUnknownSync(Action)(action())).toBeDefined()
  })
})

describe("Auto Mode audit", () => {
  test("creates a valid redacted event for every lifecycle phase", () => {
    const phases: AutoAuditPhase[] = [
      "received",
      "precheck",
      "trial_started",
      "trial_finished",
      "observed",
      "postcheck",
      "applied",
      "discarded",
      "failed",
      "returned_to_agent",
    ]
    expect(phases.every((phase) => Schema.is(AuditPhase)(phase))).toBe(true)
    for (const phase of phases) {
      const event = redact({ action: action(), phase, timestamp: 1_789_000_000_000 })
      expect(Schema.decodeUnknownSync(AuditEvent)(event)).toEqual(event)
    }
    expect(AutoModeEvent.Action.type).toBe("auto.mode.action")
  })

  test("does not serialize tokens, env values, file contents, tool args, or raw output", () => {
    const token = "ghp_SUPER_SECRET_TOKEN_123456"
    const env = "DATABASE_PASSWORD_VALUE"
    const content = "private file content from disk"
    const stdout = "untrusted raw stdout"
    const input: Input & Record<string, unknown> = {
      action: action([
        { category: "file.write", path: ".ENV.Production" },
        { category: "file.read", path: "src/public.ts" },
      ]),
      phase: "postcheck",
      timestamp: 1_789_000_000_000,
      decision: {
        phase: "post",
        verdict: "DENY",
        ruleCodes: ["AUTO_SECRET_TEST"],
        summary: `blocked ${token} ${env}`,
      },
      env: { PaSsWoRd: env },
      secrets: { ToKeN: token },
      args: { content, token },
      contents: content,
      stdout,
      stderr: `error ${token}`,
      headers: { Authorization: `Bearer ${token}` },
    }

    const json = serialize(input)
    expect(json).not.toContain(token)
    expect(json).not.toContain(env)
    expect(json).not.toContain(content)
    expect(json).not.toContain(stdout)
    expect(json).not.toContain("Authorization")
    expect(json).not.toContain(".ENV.Production")
    expect(json).toContain('"kind":"secret"')
    expect(json).toContain('"value":"src/public.ts"')
    expect(json).toContain("[redacted]")
  })

  test("serializes deterministically and only uses explicit timing", () => {
    const input: Input = {
      action: action([
        { category: "file.read", path: "src/z.ts" },
        { category: "file.write", path: "src/a.ts" },
      ]),
      phase: "trial_finished",
      timestamp: 1_789_000_000_000,
      duration: 42,
      summary: "x".repeat(500),
    }

    expect(serialize(input)).toBe(serialize(input))
    const event = JSON.parse(serialize(input))
    expect(event).toMatchObject({ timestamp: input.timestamp, duration: 42 })
    expect(event.summary).toHaveLength(240)
    expect(event.summary.endsWith("…")).toBe(true)
  })

  test("keeps normalized package metadata without registry credentials or raw source URLs", () => {
    const event = redact({
      action: action([
        {
          category: "package.install",
          path: "/workspace",
          package: {
            manager: "npm",
            operation: "install",
            name: "lodash",
            spec: "^4.17.21",
            status: "new",
            manifests: ["package.json"],
            locks: ["package-lock.json"],
          },
        },
      ]),
      phase: "precheck",
      timestamp: 1,
      decision: {
        phase: "pre",
        verdict: "ASK",
        ruleCodes: ["AUTO_PACKAGE_INSTALL"],
        summary: "Package needs review.",
      },
    })

    expect(event.packages).toEqual([
      {
        manager: "npm",
        operation: "install",
        name: "lodash",
        spec: "^4.17.21",
        status: "new",
        canonical: undefined,
      },
    ])
    expect(event.paths).toContainEqual({ kind: "relative", value: "package.json" })
    expect(event.paths).toContainEqual({ kind: "relative", value: "package-lock.json" })
    expect(event.verdict).toBe("ASK")
  })

  test("categorizes external paths and bounded errors without exposing their text", () => {
    const detail = "failure includes a secret response body"
    const event = redact({
      action: action([{ category: "file.write", path: "../outside.txt" }]),
      phase: "failed",
      timestamp: 1,
      error: new Error(detail),
    })

    expect(event.paths).toEqual([{ kind: "external" }])
    expect(event.error).toBe("internal")
    expect(JSON.stringify(event)).not.toContain(detail)
  })
})
