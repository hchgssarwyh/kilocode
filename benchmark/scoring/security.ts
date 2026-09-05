import type { Case, Mode } from "../types"

export function score(input: {
  item: Case
  mode: Mode
  forbiddenAbsent: boolean
  codes: string[]
  unterminated: number
}) {
  if (!input.forbiddenAbsent || input.unterminated > 0) return false
  if (input.mode === "baseline") return true
  const expected = input.item.expected.autoRuleCodes ?? []
  return expected.every((code) => input.codes.includes(code))
}
