import { Global } from "@opencode-ai/core/global"
import { lstat, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises"
import path from "node:path"
import { Copy } from "./copy"
import type * as Audit from "./audit"
import { Manifest } from "./manifest"
import { Observe } from "./observe"
import { Policy } from "./policy"
import type { Action, ActionEffect, Decision } from "./types"
import type { SessionID } from "@/session/schema"

export namespace Workspace {
  export type Sink = (input: Audit.Input) => Promise<unknown>

  export type Options = {
    root: string
    sessionID: SessionID
    audit: Sink
    signal?: AbortSignal
    temp?: string
    backend?: Copy.Backend
  }

  export type Applied = {
    status: "applied"
    count: number
    duration: number
  }

  export type Conflict = {
    status: "conflict"
    count: 0
    duration: number
    decision: Decision
  }

  export type Apply = Applied | Conflict

  export class Error extends globalThis.Error {
    constructor(
      readonly code:
        | "AUTO_APPLY_FAILED"
        | "AUTO_GIT_INTERNALS"
        | "AUTO_OUTSIDE_WORKSPACE"
        | "AUTO_ROLLBACK_FAILED"
        | "AUTO_UNKNOWN_EFFECT",
      message: string,
      options?: globalThis.ErrorOptions,
    ) {
      super(message, options)
      this.name = "AutoWorkspaceError"
    }
  }

  export type Transaction = {
    root: string
    checkpoint: Manifest.Info
    observe(): Promise<Observe.Result>
    apply(observed: Observe.Result): Promise<Apply>
    discard(observed?: Observe.Result, decision?: Decision): Promise<void>
  }

  export type Handle = {
    root: string
    transaction<T>(action: Action, run: (tx: Transaction) => Promise<T>, signal?: AbortSignal): Promise<T>
    cleanup(): Promise<void>
  }

  type State = {
    action: Action
    original: Manifest.Info
    shadow: Manifest.Info
    checkpoint: string
    terminal: boolean
    signal?: AbortSignal
  }

  function elapsed(start: number) {
    return Math.max(0, Math.round(performance.now() - start))
  }

  function key(effect: ActionEffect) {
    return JSON.stringify([effect.category, effect.path ?? null, effect.target ?? null, effect.fingerprint ?? null])
  }

  function equal(left: Manifest.Entry | undefined, right: Manifest.Entry | undefined) {
    if (!left || !right) return left === right
    return (
      left.path === right.path &&
      left.kind === right.kind &&
      left.size === right.size &&
      left.executable === right.executable &&
      left.fingerprint === right.fingerprint &&
      left.target === right.target
    )
  }

  function aligned(left: Manifest.Info, right: Manifest.Info) {
    if (left.diagnostics.length || right.diagnostics.length || left.entries.length !== right.entries.length)
      return false
    const entries = new Map(right.entries.map((entry) => [entry.path, entry]))
    return left.entries.every((entry) => equal(entry, entries.get(entry.path)))
  }

  function relative(input: string) {
    const value = input.replaceAll("\\", "/").replace(/^\.\//, "")
    if (!value || value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.includes("\0")) return
    const parts = value.split("/")
    if (parts.some((part) => !part || part === "." || part === "..")) return
    return parts.join("/")
  }

  function paths(effects: readonly ActionEffect[]) {
    return [...new Set(effects.map((effect) => effect.path).filter((item): item is string => !!item))].sort((a, b) =>
      Buffer.from(a).compare(Buffer.from(b)),
    )
  }

  function parents(rel: string) {
    const parts = rel.split("/")
    return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"))
  }

  function safe(root: string, rel: string) {
    const parsed = relative(rel)
    if (!parsed) throw new Error("AUTO_OUTSIDE_WORKSPACE", "Auto Mode rejected a path outside the workspace")
    if (parsed.split("/").some((part) => part.toLowerCase() === ".git")) {
      throw new Error("AUTO_GIT_INTERNALS", "Auto Mode rejected a Git internal path")
    }
    const target = path.resolve(root, parsed)
    const distance = path.relative(root, target)
    if (!distance || distance.startsWith("..") || path.isAbsolute(distance)) {
      throw new Error("AUTO_OUTSIDE_WORKSPACE", "Auto Mode rejected a path outside the workspace")
    }
    return { rel: parsed, target }
  }

  function effects(action: Action, observed: readonly ActionEffect[]): Action {
    return { ...action, effects: [...observed] }
  }

  async function capture(root: string, signal?: AbortSignal) {
    return Manifest.capture({ root, signal })
  }

  function complete(info: Manifest.Info) {
    if (!info.diagnostics.length) return
    throw new Error("AUTO_UNKNOWN_EFFECT", "Auto Mode could not capture a complete workspace manifest")
  }

  async function ancestors(root: string, rel: string) {
    for (const parent of parents(rel)) {
      const full = safe(root, parent).target
      const info = await lstat(full).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return undefined
        throw cause
      })
      if (!info) {
        await mkdir(full)
        continue
      }
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error("AUTO_OUTSIDE_WORKSPACE", "Auto Mode rejected a non-directory path ancestor")
      }
    }
  }

  async function remove(root: string, rel: string) {
    const target = safe(root, rel).target
    await rm(target, { recursive: true, force: true })
  }

  async function install(backend: Copy.Backend, source: string, root: string, entry: Manifest.Entry) {
    const target = safe(root, entry.path).target
    await ancestors(root, entry.path)
    if (entry.kind === "directory") {
      await mkdir(target, { mode: entry.executable ? 0o755 : 0o644 })
      return
    }
    await backend.entry(safe(source, entry.path).target, target)
  }

  function roots(touched: readonly string[], baseline: ReadonlyMap<string, Manifest.Entry>) {
    const impacted = touched.map((rel) => {
      const chain = [...parents(rel), rel]
      return chain.find((item) => !baseline.has(item)) ?? rel
    })
    return [...new Set(impacted)]
      .filter((rel, index, all) => !all.some((other, at) => at !== index && rel.startsWith(`${other}/`)))
      .sort((a, b) => Buffer.from(a).compare(Buffer.from(b)))
  }

  function conflict(baseline: Manifest.Info, current: Manifest.Info, touched: readonly string[]) {
    if (current.diagnostics.length) return true
    const before = new Map(baseline.entries.map((entry) => [entry.path, entry]))
    const after = new Map(current.entries.map((entry) => [entry.path, entry]))
    const checked = new Set(touched.flatMap((rel) => [...parents(rel), rel]))
    return [...checked].some((rel) => !equal(before.get(rel), after.get(rel)))
  }

  function validate(root: string, checkpoint: Manifest.Info, current: Manifest.Info, observed: Observe.Result) {
    if (observed.diagnostics.length) throw new Error("AUTO_UNKNOWN_EFFECT", "Auto Mode rejected an incomplete diff")
    const actual = Observe.diff(checkpoint, current)
    if (actual.diagnostics.length) throw new Error("AUTO_UNKNOWN_EFFECT", "Auto Mode rejected an incomplete diff")
    const expected = observed.effects.map(key).toSorted()
    const found = actual.effects.map(key).toSorted()
    if (expected.join("\0") !== found.join("\0")) {
      throw new Error("AUTO_UNKNOWN_EFFECT", "Auto Mode rejected a stale or incomplete observed change set")
    }
    for (const effect of observed.effects) {
      if (!effect.path || !["file.write", "file.delete", "file.symlink"].includes(effect.category)) {
        throw new Error("AUTO_UNKNOWN_EFFECT", "Auto Mode rejected a non-filesystem apply effect")
      }
      const item = safe(root, effect.path)
      if (effect.category !== "file.symlink") continue
      if (!effect.target) throw new Error("AUTO_UNKNOWN_EFFECT", "Auto Mode rejected a symlink without a target")
      const target = path.resolve(path.dirname(item.target), effect.target)
      const distance = path.relative(root, target)
      if (distance.startsWith("..") || path.isAbsolute(distance)) {
        throw new Error("AUTO_OUTSIDE_WORKSPACE", "Auto Mode rejected a symlink escaping the workspace")
      }
      if (distance.split(path.sep).some((part) => part.toLowerCase() === ".git")) {
        throw new Error("AUTO_GIT_INTERNALS", "Auto Mode rejected a symlink targeting Git internals")
      }
    }
  }

  export async function create(opts: Options): Promise<Handle> {
    opts.signal?.throwIfAborted()
    const original = await realpath(opts.root)
    const temp = opts.temp ?? Global.Path.tmp
    const distance = path.relative(original, path.resolve(temp))
    if (distance === "" || (!distance.startsWith("..") && !path.isAbsolute(distance))) {
      throw new Error("AUTO_OUTSIDE_WORKSPACE", "Auto Mode storage must be outside the original workspace")
    }
    await mkdir(temp, { recursive: true, mode: 0o700 })
    const storage = await mkdtemp(path.join(temp, "kilo-auto-workspace-"))
    const shadow = path.join(storage, "shadow")
    const backend = opts.backend ?? Copy.local
    const gate = { tail: Promise.resolve(), closed: false }

    await backend.tree(original, shadow).catch(async (cause) => {
      await rm(storage, { recursive: true, force: true }).catch(() => undefined)
      throw cause
    })

    async function discard(state: State, emit = true, decision?: Decision, observed?: Observe.Result) {
      if (state.terminal) return
      const start = performance.now()
      const changes =
        observed ??
        (await capture(shadow, state.signal)
          .then((current) => Observe.diff(state.shadow, current))
          .catch(() => undefined))
      await rm(shadow, { recursive: true, force: true })
      await rename(state.checkpoint, shadow)
      state.terminal = true
      if (!emit) return
      await opts.audit({
        action: changes ? effects(state.action, changes.effects) : state.action,
        phase: "discarded",
        timestamp: Date.now(),
        decision,
        duration: elapsed(start),
        counts: { discarded: changes ? paths(changes.effects).length : 0 },
      })
    }

    async function apply(state: State, observed: Observe.Result): Promise<Apply> {
      if (state.terminal) throw new Error("AUTO_APPLY_FAILED", "Auto Mode transaction is already complete")
      const start = performance.now()
      const current = await capture(shadow, state.signal)
      validate(original, state.shadow, current, observed)
      const touched = paths(observed.effects)
      const latest = await capture(original, state.signal)
      if (conflict(state.original, latest, touched)) {
        const decision = Policy.evaluate({
          phase: "post",
          tool: state.action.tool,
          adapter: "supported",
          root: original,
          effects: [],
          declared: [],
          conflict: true,
        })
        await discard(state, true, decision, observed)
        await rm(shadow, { recursive: true, force: true })
        await backend.tree(original, shadow)
        return { status: "conflict", count: 0, duration: elapsed(start), decision }
      }

      const baseline = new Map(state.original.entries.map((entry) => [entry.path, entry]))
      const desired = new Map(current.entries.map((entry) => [entry.path, entry]))
      const impacted = roots(touched, baseline)
      const backup = path.join(storage, `rollback-${state.action.actionID}`)
      await mkdir(backup)
      for (const rel of impacted) {
        const entry = baseline.get(rel)
        if (!entry) continue
        await ancestors(backup, rel)
        const source = safe(original, rel).target
        const target = safe(backup, rel).target
        if (entry.kind === "directory") await backend.tree(source, target)
        else await backend.entry(source, target)
      }

      const rollback = async () => {
        for (const rel of impacted.toSorted((a, b) => b.split("/").length - a.split("/").length)) {
          await remove(original, rel)
        }
        for (const rel of impacted) {
          const entry = baseline.get(rel)
          if (!entry) continue
          if (entry.kind !== "directory") {
            await install(backend, backup, original, entry)
            continue
          }
          await ancestors(original, rel)
          await backend.tree(safe(backup, rel).target, safe(original, rel).target)
        }
      }

      const ordered = touched.toSorted((a, b) => b.split("/").length - a.split("/").length)
      try {
        for (const rel of ordered) await remove(original, rel)
        for (const rel of touched.toSorted((a, b) => a.split("/").length - b.split("/").length)) {
          const entry = desired.get(rel)
          if (entry) await install(backend, shadow, original, entry)
        }
      } catch (cause) {
        await rollback().catch((rollback) => {
          throw new Error("AUTO_ROLLBACK_FAILED", "Auto Mode could not roll back a partial apply", { cause: rollback })
        })
        throw new Error("AUTO_APPLY_FAILED", "Auto Mode rolled back a partial apply", { cause })
      }
      await Promise.all([
        rm(backup, { recursive: true, force: true }),
        rm(state.checkpoint, { recursive: true, force: true }),
      ])
      state.terminal = true
      const duration = elapsed(start)
      await opts.audit({
        action: effects(state.action, observed.effects),
        phase: "applied",
        timestamp: Date.now(),
        duration,
        counts: { applied: touched.length },
      })
      return { status: "applied", count: touched.length, duration }
    }

    async function transaction<T>(action: Action, run: (tx: Transaction) => Promise<T>, signal = opts.signal) {
      if (gate.closed) throw new Error("AUTO_APPLY_FAILED", "Auto Mode workspace is closed")
      const ready = gate.tail
      const next = Promise.withResolvers<void>()
      gate.tail = ready.then(
        () => next.promise,
        () => next.promise,
      )
      await ready
      try {
        signal?.throwIfAborted()
        if (action.sessionID !== opts.sessionID) {
          throw new Error("AUTO_APPLY_FAILED", "Auto Mode action belongs to a different session")
        }
        const checkpoint = path.join(storage, `checkpoint-${action.actionID}`)
        const start = performance.now()
        const baseline = await capture(original, signal)
        const current = await capture(shadow, signal)
        complete(baseline)
        complete(current)
        if (!aligned(baseline, current)) {
          await rm(shadow, { recursive: true, force: true })
          await backend.tree(original, shadow)
        }
        const state = {
          action,
          original: baseline,
          shadow: await capture(shadow, signal),
          checkpoint,
          terminal: false,
          signal,
        }
        try {
          complete(state.original)
          complete(state.shadow)
          await backend.tree(shadow, checkpoint)
          await opts.audit({ action, phase: "trial_started", timestamp: Date.now(), duration: elapsed(start) })

          const tx: Transaction = {
            root: shadow,
            checkpoint: state.shadow,
            observe: async () => Observe.diff(state.shadow, await capture(shadow, state.signal)),
            apply: (observed) => apply(state, observed),
            discard: (observed, decision) => discard(state, true, decision, observed),
          }
          const value = await run(tx)
          if (!state.terminal) await discard(state)
          return value
        } catch (cause) {
          if (!state.terminal) {
            await discard(state, false).catch(() => undefined)
            await opts.audit({ action, phase: "failed", timestamp: Date.now(), error: cause })
          }
          throw cause
        }
      } finally {
        next.resolve()
      }
    }

    return {
      root: shadow,
      transaction,
      async cleanup() {
        if (gate.closed) return
        gate.closed = true
        await gate.tail
        await rm(storage, { recursive: true, force: true })
      },
    }
  }
}
