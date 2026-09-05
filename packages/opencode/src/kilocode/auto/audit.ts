import { Bus } from "@/bus"
import * as Log from "@opencode-ai/core/util/log"
import { Effect, Schema } from "effect"
import { AuditError, AuditEvent, type AuditPath, AutoModeEvent } from "./event"
import { Action, AuditCount, AuditPhase, Decision } from "./types"

const log = Log.create({ service: "auto.mode" })
const secret =
  /(?:^|[-_.])(env(?:ironment)?|token|secret|password|passwd|authorization|auth|cookie|credential|api[-_]?key|private[-_]?key)(?:$|[-_.])/i
const hidden =
  /^(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|\.npmrc|\.pypirc|\.netrc|auth\.json)$/i
const token = /\b(?:Bearer\s+\S+|(?:gh[pousr]|github_pat|sk)-[A-Za-z0-9_-]{8,})\b/gi

export type Input = {
  action: Action
  phase: Schema.Schema.Type<typeof AuditPhase>
  timestamp: number
  decision?: Decision
  paths?: readonly string[]
  counts?: Partial<Schema.Schema.Type<typeof AuditCount>>
  duration?: number
  summary?: string
  error?: unknown
  env?: unknown
  secrets?: unknown
}

function values(input: unknown, force = false, depth = 0): string[] {
  if (depth > 8 || input == null) return []
  if (typeof input === "string" || typeof input === "number" || typeof input === "boolean") {
    return force ? [String(input)] : []
  }
  if (Array.isArray(input)) return input.flatMap((value) => values(value, force, depth + 1))
  if (typeof input !== "object") return []
  return Object.entries(input).flatMap(([key, value]) => values(value, force || secret.test(key), depth + 1))
}

function message(input: string, secrets: readonly string[]) {
  const clean = secrets
    .filter((value) => value.length > 0)
    .toSorted((a, b) => b.length - a.length || a.localeCompare(b))
    .reduce((text, value) => text.split(value).join("[redacted]"), input)
    .replace(token, "[redacted]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!clean) return undefined
  return clean.length <= 240 ? clean : clean.slice(0, 239) + "…"
}

function path(input: string): AuditPath {
  const normalized = input.replaceAll("\\", "/")
  const parts = normalized.split("/").filter((part) => part && part !== ".")
  if (parts.some((part) => hidden.test(part))) return { kind: "secret" }
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")) {
    return { kind: "external" }
  }
  if (parts.includes("..") || parts.length === 0) return { kind: "external" }
  return { kind: "relative", value: parts.join("/").slice(0, 4_096) }
}

function error(input: unknown): Schema.Schema.Type<typeof AuditError> | undefined {
  if (input == null) return undefined
  const name = input instanceof Error ? input.name : typeof input === "string" ? input : ""
  if (/abort|cancel/i.test(name)) return "cancelled"
  if (/timeout/i.test(name)) return "timeout"
  if (/parse|schema|valid/i.test(name)) return "invalid"
  if (input instanceof Error) return "internal"
  return "unknown"
}

export function redact(input: Input): AuditEvent {
  const action = Schema.decodeUnknownSync(Action)(input.action)
  const decision = input.decision ? Schema.decodeUnknownSync(Decision)(input.decision) : undefined
  const secrets = [...values(input.env, true), ...values(input.secrets, true)]
  const paths = [
    ...action.effects.flatMap((effect) => [
      ...(effect.path ? [effect.path] : []),
      ...(effect.package?.manifests ?? []),
      ...(effect.package?.locks ?? []),
    ]),
    ...(input.paths ?? []),
  ]
    .map(path)
    .filter(
      (item, index, all) => all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(item)) === index,
    )
    .toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  const effects = action.effects
    .map((effect) => effect.category)
    .filter((item, index, all) => all.indexOf(item) === index)
    .toSorted()
  const fingerprints = action.effects
    .flatMap((effect) => (effect.fingerprint ? [effect.fingerprint] : []))
    .filter((item, index, all) => all.indexOf(item) === index)
    .toSorted()
  const packages = action.effects
    .flatMap((effect) => (effect.package ? [effect.package] : []))
    .map((pkg) => ({
      manager: pkg.manager,
      operation: pkg.operation,
      name: pkg.name,
      spec: pkg.spec,
      status: pkg.status,
      canonical: pkg.canonical,
    }))
    .filter(
      (item, index, all) => all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(item)) === index,
    )
    .toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  const summary = message(input.summary ?? decision?.summary ?? "", secrets)
  return Schema.decodeUnknownSync(AuditEvent)({
    sessionID: action.sessionID,
    actionID: action.actionID,
    tool: action.tool,
    phase: input.phase,
    timestamp: input.timestamp,
    effects,
    fingerprints,
    paths,
    packages,
    verdict: decision?.verdict,
    ruleCodes: decision?.ruleCodes ?? [],
    counts: {
      effects: input.counts?.effects ?? effects.length,
      files: input.counts?.files ?? paths.length,
      applied: input.counts?.applied ?? 0,
      discarded: input.counts?.discarded ?? 0,
    },
    duration: input.duration,
    summary,
    error: error(input.error),
  })
}

function canonical(input: unknown): string {
  if (input === undefined) return "null"
  if (input == null || typeof input !== "object") return JSON.stringify(input)
  if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`
  const entries = Object.entries(input)
    .filter(([, value]) => value !== undefined)
    .toSorted(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`).join(",")}}`
}

export function serialize(input: Input) {
  return canonical(redact(input))
}

export const publish = Effect.fn("AutoAudit.publish")(function* (input: Input) {
  const event = redact(input)
  log.info("action", { event })
  const bus = yield* Bus.Service
  yield* bus.publish(AutoModeEvent.Action, event)
  return event
})
