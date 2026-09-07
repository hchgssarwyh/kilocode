import { BusEvent } from "@/bus/bus-event"
import { SessionID } from "@/session/schema"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Schema } from "effect"
import { ActionEffectCategory, ActionID, AuditCount, AuditPhase, Fingerprint, RuleCode, Verdict } from "./types"

const RelativePath = Schema.Struct({
  kind: Schema.Literal("relative"),
  value: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
})

export const AuditPath = Schema.Union([
  RelativePath,
  Schema.Struct({ kind: Schema.Literal("secret") }),
  Schema.Struct({ kind: Schema.Literal("external") }),
]).annotate({ identifier: "AutoAuditPath" })
export type AuditPath = Schema.Schema.Type<typeof AuditPath>

export const AuditError = Schema.Literals(["cancelled", "timeout", "invalid", "internal", "unknown"]).annotate({
  identifier: "AutoAuditError",
})
export type AuditError = Schema.Schema.Type<typeof AuditError>

export const AuditPackage = Schema.Struct({
  manager: Schema.Literals(["bun", "npm", "pnpm", "yarn", "unsupported"]),
  operation: Schema.Literals(["install", "add", "update", "remove"]),
  name: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
  spec: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
  status: Schema.Literals(["existing", "new", "suspicious", "unknown", "unsupported"]),
  canonical: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
}).annotate({ identifier: "AutoAuditPackage" })
export type AuditPackage = Schema.Schema.Type<typeof AuditPackage>

export const AuditEvent = Schema.Struct({
  sessionID: SessionID,
  actionID: ActionID,
  tool: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  phase: AuditPhase,
  timestamp: NonNegativeInt,
  effects: Schema.Array(ActionEffectCategory),
  fingerprints: Schema.Array(Fingerprint),
  paths: Schema.Array(AuditPath),
  packages: Schema.Array(AuditPackage),
  verdict: Schema.optional(Verdict),
  ruleCodes: Schema.Array(RuleCode),
  counts: AuditCount,
  duration: Schema.optional(NonNegativeInt),
  summary: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240))),
  error: Schema.optional(AuditError),
}).annotate({ identifier: "AutoAuditEvent" })
export type AuditEvent = Schema.Schema.Type<typeof AuditEvent>

export const AutoModeEvent = {
  Action: BusEvent.define("auto.mode.action", AuditEvent),
}
