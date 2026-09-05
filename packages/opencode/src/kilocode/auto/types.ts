import { SessionID } from "@/session/schema"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Hash } from "@opencode-ai/core/util/hash"
import { Schema } from "effect"

const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))
const Path = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096))
export const Fingerprint = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Identity = Schema.Struct({ sessionID: SessionID, callID: Name })

export const ActionID = Schema.String.check(Schema.isPattern(/^act_[a-f0-9]{32}$/)).pipe(Schema.brand("AutoActionID"))
export type ActionID = Schema.Schema.Type<typeof ActionID>

export const ActionEffectCategory = Schema.Literals([
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
]).annotate({ identifier: "AutoActionEffectCategory" })
export type ActionEffectCategory = Schema.Schema.Type<typeof ActionEffectCategory>

export const PackageInfo = Schema.Struct({
  manager: Schema.Literals(["bun", "npm", "pnpm", "yarn", "unsupported"]),
  operation: Schema.Literals(["install", "add", "update", "remove"]),
  name: Schema.optional(Name),
  spec: Schema.optional(Name),
  status: Schema.Literals(["existing", "new", "suspicious", "unknown", "unsupported"]),
  canonical: Schema.optional(Name),
  manifests: Schema.Array(Path),
  locks: Schema.Array(Path),
}).annotate({ identifier: "AutoPackageInfo" })
export type PackageInfo = Schema.Schema.Type<typeof PackageInfo>

export const ActionEffect = Schema.Struct({
  category: ActionEffectCategory,
  path: Schema.optional(Path),
  target: Schema.optional(Path),
  fingerprint: Schema.optional(Fingerprint),
  package: Schema.optional(PackageInfo),
}).annotate({ identifier: "AutoActionEffect" })
export type ActionEffect = Schema.Schema.Type<typeof ActionEffect>

export const Verdict = Schema.Literals(["ALLOW", "ASK", "DENY"]).annotate({ identifier: "AutoVerdict" })
export type Verdict = Schema.Schema.Type<typeof Verdict>

export const Phase = Schema.Literals(["pre", "post"]).annotate({ identifier: "AutoDecisionPhase" })
export type Phase = Schema.Schema.Type<typeof Phase>

export const RuleCode = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^AUTO_[A-Z0-9_]+$/),
).annotate({ identifier: "AutoRuleCode" })
export type RuleCode = Schema.Schema.Type<typeof RuleCode>

const Summary = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240))
const Rules = Schema.Array(RuleCode)
const RequiredRules = Schema.NonEmptyArray(RuleCode)

export const Decision = Schema.Union([
  Schema.Struct({
    phase: Phase,
    verdict: Schema.Literal("ALLOW"),
    ruleCodes: Rules,
    summary: Summary,
  }),
  Schema.Struct({
    phase: Phase,
    verdict: Schema.Literals(["ASK", "DENY"]),
    ruleCodes: RequiredRules,
    summary: Summary,
  }),
]).annotate({ identifier: "AutoDecision" })
export type Decision = Schema.Schema.Type<typeof Decision>

export const Action = Schema.Struct({
  actionID: ActionID,
  sessionID: SessionID,
  callID: Name,
  tool: Name,
  effects: Schema.Array(ActionEffect),
}).annotate({ identifier: "AutoAction" })
export type Action = Schema.Schema.Type<typeof Action>

export const AuditPhase = Schema.Literals([
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
]).annotate({ identifier: "AutoAuditPhase" })
export type AuditPhase = Schema.Schema.Type<typeof AuditPhase>

export const AuditCount = Schema.Struct({
  effects: NonNegativeInt,
  files: NonNegativeInt,
  applied: NonNegativeInt,
  discarded: NonNegativeInt,
}).annotate({ identifier: "AutoAuditCount" })
export type AuditCount = Schema.Schema.Type<typeof AuditCount>

export function createActionID(input: { sessionID: SessionID; callID: string }): ActionID {
  const identity = Schema.decodeUnknownSync(Identity)(input)
  const hash = Hash.sha256(JSON.stringify([identity.sessionID, identity.callID])).slice(0, 32)
  return ActionID.make(`act_${hash}`)
}
