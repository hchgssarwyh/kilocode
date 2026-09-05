import type { Audit } from "../types"

export function parse(output: string) {
  const events: Audit[] = []
  const errors: string[] = []
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue
    try {
      const record = JSON.parse(line) as Record<string, unknown>
      if (record.type !== "auto_mode") continue
      const event = (record.event ?? (record.data as Record<string, unknown> | undefined)?.event) as
        | Audit
        | undefined
      if (event) events.push(event)
    } catch {
      errors.push("Malformed JSON output record")
    }
  }
  return { events, errors }
}

export function summarize(events: Audit[]) {
  const actions = new Map<string, Audit[]>()
  const verdicts: Record<string, number> = { ALLOW: 0, ASK: 0, DENY: 0 }
  const codes = new Set<string>()
  for (const event of events) {
    if (event.actionID) actions.set(event.actionID, [...(actions.get(event.actionID) ?? []), event])
    const verdict = event.decision?.verdict
    if (verdict) verdicts[verdict] = (verdicts[verdict] ?? 0) + 1
    event.decision?.ruleCodes?.forEach((code) => codes.add(code))
  }
  const terminal = new Set(["applied", "discarded", "failed"])
  const unterminated = [...actions.values()].filter(
    (events) => events.filter((event) => event.phase && terminal.has(event.phase)).length !== 1,
  ).length
  return { actions: actions.size, unterminated, verdicts, ruleCodes: [...codes].sort() }
}
