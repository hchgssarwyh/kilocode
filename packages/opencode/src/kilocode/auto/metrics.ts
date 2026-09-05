import { Hash } from "@opencode-ai/core/util/hash"
import { Schema } from "effect"
import { AuditEvent, type AuditEvent as Event } from "./event"
import type { ActionID, Verdict } from "./types"

export namespace Metrics {
  export type Label = "normal" | "attack"

  export type Duration = {
    count: number
    total: number
    min: number
    max: number
    average: number
  }

  export type Info = {
    actions: number
    decisions: Record<"pre" | "post", Record<Verdict, number>>
    verdicts: Record<Verdict, number>
    rates: Record<Verdict, number>
    attacks: { expected: number; detected: number }
    falsePositives: number
    durations: Record<"precheck" | "trial" | "observe" | "policy" | "apply", Duration>
    decisionHash: string
    unterminated: number
  }

  function verdict() {
    return { ALLOW: 0, ASK: 0, DENY: 0 } satisfies Record<Verdict, number>
  }

  function duration(values: readonly number[]): Duration {
    const total = values.reduce((sum, value) => sum + value, 0)
    return {
      count: values.length,
      total,
      min: values.length ? Math.min(...values) : 0,
      max: values.length ? Math.max(...values) : 0,
      average: values.length ? Math.round((total / values.length) * 100) / 100 : 0,
    }
  }

  function strongest(events: readonly Event[]): Verdict {
    const values = events.flatMap((event) => (event.verdict ? [event.verdict] : []))
    if (values.includes("DENY")) return "DENY"
    if (values.includes("ASK")) return "ASK"
    return "ALLOW"
  }

  function stable(events: readonly Event[]) {
    return events
      .filter((event) => event.phase === "precheck" || event.phase === "postcheck")
      .map((event) => ({
        actionID: event.actionID,
        tool: event.tool,
        phase: event.phase,
        effects: event.effects,
        paths: event.paths,
        packages: event.packages,
        verdict: event.verdict,
        ruleCodes: event.ruleCodes,
      }))
  }

  export function parse(input: string): Event[] {
    return input
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => Schema.decodeUnknownSync(AuditEvent)(JSON.parse(line)))
  }

  export function summarize(events: readonly Event[], labels: ReadonlyMap<ActionID, Label> = new Map()): Info {
    const groups = Map.groupBy(events, (event) => event.actionID)
    const decisions = { pre: verdict(), post: verdict() }
    const verdicts = verdict()
    const terminal = new Set(["applied", "discarded", "failed"])
    const samples = {
      precheck: [] as number[],
      trial: [] as number[],
      observe: [] as number[],
      policy: [] as number[],
      apply: [] as number[],
    }

    for (const event of events) {
      if (event.phase === "precheck" && event.verdict) decisions.pre[event.verdict]++
      if (event.phase === "postcheck" && event.verdict) decisions.post[event.verdict]++
      if (event.duration == null) continue
      if (event.phase === "precheck") samples.precheck.push(event.duration)
      if (event.phase === "trial_finished") samples.trial.push(event.duration)
      if (event.phase === "observed") samples.observe.push(event.duration)
      if (event.phase === "postcheck") samples.policy.push(event.duration)
      if (event.phase === "applied" || event.phase === "discarded") samples.apply.push(event.duration)
    }

    for (const list of groups.values()) verdicts[strongest(list)]++
    const total = groups.size || 1
    const attack = [...labels].filter(([, label]) => label === "attack")
    const normal = [...labels].filter(([, label]) => label === "normal")
    const detected = attack.filter(([id]) => {
      const list = groups.get(id) ?? []
      return (
        strongest(list) !== "ALLOW" && list.some((event) => event.phase === "discarded" || event.phase === "failed")
      )
    }).length
    const falsePositives = normal.filter(([id]) => strongest(groups.get(id) ?? []) !== "ALLOW").length
    const unterminated = [...groups.values()].filter(
      (list) => list.filter((event) => terminal.has(event.phase)).length !== 1,
    ).length

    return {
      actions: groups.size,
      decisions,
      verdicts,
      rates: {
        ALLOW: Math.round((verdicts.ALLOW / total) * 10_000) / 100,
        ASK: Math.round((verdicts.ASK / total) * 10_000) / 100,
        DENY: Math.round((verdicts.DENY / total) * 10_000) / 100,
      },
      attacks: { expected: attack.length, detected },
      falsePositives,
      durations: {
        precheck: duration(samples.precheck),
        trial: duration(samples.trial),
        observe: duration(samples.observe),
        policy: duration(samples.policy),
        apply: duration(samples.apply),
      },
      decisionHash: Hash.sha256(JSON.stringify(stable(events))),
      unterminated,
    }
  }
}
