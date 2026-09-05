import { Global } from "@opencode-ai/core/global"
import { backendSupport } from "@kilocode/sandbox"
import { randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, open } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import * as Audit from "@/kilocode/auto/audit"
import { AuditEvent as AuditEventSchema, AutoModeEvent, type AuditEvent, type AuditPath } from "@/kilocode/auto/event"
import { Gateway } from "@/kilocode/auto/gateway"
import { SessionID } from "@/session/schema"

export namespace AutoModeCLI {
  export type Summary = {
    actions: number
    applied: number
    denied: number
    asked: number
    protected: number
    audit: string
  }

  export type Handle = {
    path: string
    record: (input: Audit.Input) => Promise<void>
    render: (event: AuditEvent) => string | undefined
    summary: () => Summary
    close: () => Promise<void>
  }

  type State = {
    order: Map<string, number>
    applied: Set<string>
    denied: Set<string>
    asked: Set<string>
    protected: Set<string>
  }

  export function preflight(check: typeof backendSupport = backendSupport) {
    const support = check({ mode: "deny", allowedHosts: [] })
    if (support.available) return
    throw new Error(support.reason ?? "The Auto Mode sandbox backend is unavailable")
  }

  export function parse(input: unknown, sessionID: string) {
    if (typeof input !== "object" || input == null || !("type" in input) || !("properties" in input)) return
    if (input.type !== AutoModeEvent.Action.type) return
    if (!Schema.is(AuditEventSchema)(input.properties)) return
    if (input.properties.sessionID !== sessionID) return
    return input.properties
  }

  export function permission(input: { metadata?: Record<string, unknown> }, enabled: boolean) {
    if (!enabled) return
    if (input.metadata?.autoMode === true) return "review" as const
    if (input.metadata?.autoModeTrial === true) return "trial" as const
  }

  function safe(id: string) {
    return id.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 160)
  }

  function rank(state: State, id: string) {
    const current = state.order.get(id)
    if (current) return current
    const next = state.order.size + 1
    state.order.set(id, next)
    return next
  }

  function display(value: AuditPath | undefined) {
    if (!value) return
    if (value.kind === "relative") return value.value
    if (value.kind === "secret") return "[secret path]"
    return "[external path]"
  }

  function target(event: AuditEvent) {
    return display(event.paths.at(0)) ?? event.effects.at(0)
  }

  function count(value: number, noun: string) {
    return `${value} ${noun}${value === 1 ? "" : "s"}`
  }

  function trace(state: State, event: AuditEvent) {
    const prefix = `AUTO #a${rank(state, event.actionID)} ${event.tool}`
    const item = target(event)
    const label = item ? `${prefix} ${item}` : prefix
    const rules = event.ruleCodes.length ? ` ${event.ruleCodes.join(",")}` : ""
    if (event.phase === "precheck") return `${label} pre ${event.verdict}${rules}`
    if (event.phase === "trial_finished") return `${prefix} trial ${event.duration ?? 0} ms`
    if (event.phase === "observed") return `${prefix} observed ${count(event.counts.files, "file")}`
    if (event.phase === "postcheck") return `${label} post ${event.verdict}${rules}`
    if (event.phase === "applied") {
      return `${prefix} applied ${count(event.counts.applied, "file")} ${event.duration ?? 0} ms`
    }
    if (event.phase === "discarded") {
      return `${prefix} discarded ${count(event.counts.discarded, "file")}${event.verdict ? ` ${event.verdict}` : ""}${rules}`
    }
    if (event.phase === "failed") return `${prefix} failed${event.error ? ` ${event.error}` : ""}`
  }

  function update(state: State, event: AuditEvent) {
    rank(state, event.actionID)
    if (event.verdict === "ASK") state.asked.add(event.actionID)
    if (event.verdict === "DENY") state.denied.add(event.actionID)
    if (event.phase === "applied") state.applied.add(event.actionID)
    if (
      event.phase === "discarded" &&
      event.effects.some((effect) => effect.startsWith("file.") || effect === "persistence.create")
    ) {
      state.protected.add(event.actionID)
    }
  }

  export async function create(input: { sessionID: string; dir?: string }): Promise<Handle> {
    const dir = path.resolve(input.dir ?? path.join(Global.Path.state, "auto-mode"))
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const info = await lstat(dir)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Auto Mode audit directory is not safe")
    await chmod(dir, 0o700)
    const file = path.join(dir, `${safe(input.sessionID)}-${Date.now()}-${randomUUID()}.jsonl`)
    const handle = await open(file, "wx", 0o600)
    const state: State = {
      order: new Map(),
      applied: new Set(),
      denied: new Set(),
      asked: new Set(),
      protected: new Set(),
    }
    const queue = { pending: Promise.resolve(), closed: false }

    const record = async (value: Audit.Input) => {
      if (queue.closed) throw new Error("Auto Mode audit file is closed")
      const event = Audit.redact(value)
      update(state, event)
      queue.pending = queue.pending.then(() => handle.appendFile(Audit.serialize(value) + "\n", { encoding: "utf8" }))
      await queue.pending
    }

    return {
      path: file,
      record,
      render: (event) => trace(state, event),
      summary: () => ({
        actions: state.order.size,
        applied: state.applied.size,
        denied: state.denied.size,
        asked: state.asked.size,
        protected: state.protected.size,
        audit: file,
      }),
      async close() {
        if (queue.closed) return
        queue.closed = true
        await queue.pending
        await handle.sync()
        await handle.close()
      },
    }
  }

  export async function start(input: { sessionID: string; root: string; dir?: string }) {
    preflight()
    const dir = path.resolve(input.dir ?? path.join(Global.Path.state, "auto-mode"))
    const rel = path.relative(path.resolve(input.root), dir)
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
      throw new Error("Auto Mode audit directory must be outside the workspace")
    }
    const handle = await create(input)
    try {
      Gateway.activate({ sessionID: SessionID.make(input.sessionID), root: input.root, record: handle.record })
      return handle
    } catch (error) {
      await handle.close()
      throw error
    }
  }

  export async function stop(sessionID: string, handle: Handle) {
    await Gateway.deactivate(SessionID.make(sessionID)).finally(() => handle.close())
  }

  export function summary(value: Summary) {
    return [
      `Auto Mode: ${value.actions} actions, ${value.applied} applied, ${value.denied} denied, ${value.asked} asked`,
      `Protected: ${value.protected} unsafe filesystem action${value.protected === 1 ? "" : "s"} discarded`,
      `Audit: ${value.audit}`,
    ]
  }
}
