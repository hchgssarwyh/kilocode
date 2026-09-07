import { Schema } from "effect"
import { ActionEffect, Decision, Phase } from "./types"
import * as Rules from "./rules"

export namespace Policy {
  const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096))

  export const Input = Schema.Struct({
    phase: Phase,
    tool: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    adapter: Schema.Literals(["supported", "unsupported"]),
    root: Text,
    effects: Schema.Array(ActionEffect),
    declared: Schema.optional(Schema.Array(ActionEffect)),
    conflict: Schema.optional(Schema.Boolean),
  }).annotate({ identifier: "AutoPolicyInput" })
  export type Input = Schema.Schema.Type<typeof Input>

  function phase(input: unknown) {
    try {
      if (typeof input !== "object" || input == null || !("phase" in input)) return "pre"
      return Schema.is(Phase)(input.phase) ? input.phase : "pre"
    } catch {
      return "pre"
    }
  }

  function failed(input: unknown): Decision {
    return {
      phase: phase(input),
      verdict: "DENY",
      ruleCodes: ["AUTO_POLICY_ERROR"],
      summary: "Policy denied the action because evaluation failed.",
    }
  }

  export function evaluate(input: unknown): Decision {
    try {
      const parsed = Schema.decodeUnknownSync(Input)(input)
      return Schema.decodeUnknownSync(Decision)(Rules.decide(parsed))
    } catch {
      return failed(input)
    }
  }
}
