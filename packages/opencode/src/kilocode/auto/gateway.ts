import { InstanceRef } from "@/effect/instance-ref"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { Instance } from "@/kilocode/instance"
import type { SessionID } from "@/session/schema"
import type { Tool } from "@/tool/tool"
import { Effect, Exit, Schema } from "effect"
import * as Audit from "./audit"
import { Adapter } from "./adapter"
import { Policy } from "./policy"
import { ActionID, Decision, RuleCode, createActionID, type Action, type ActionEffect } from "./types"
import { Workspace } from "./workspace"
import type * as Package from "./package"

export namespace Gateway {
  export class Denied extends Schema.TaggedErrorClass<Denied>()("AutoModeDenied", {
    actionID: ActionID,
    tool: Schema.String,
    phase: Schema.Literals(["pre", "post"]),
    verdict: Schema.Literals(["ASK", "DENY"]),
    ruleCodes: Schema.NonEmptyArray(RuleCode),
    summary: Schema.String,
  }) {
    override get message() {
      return `Auto Mode blocked ${this.tool}: ${this.ruleCodes.join(", ")}. ${this.summary}`
    }
  }

  export type Options = {
    sessionID: SessionID
    root: string
    audit?: Workspace.Sink
    record?: Workspace.Sink
    temp?: string
    packageChecker?: Package.Checker
    packageTimeout?: number
  }

  type State = Options & {
    workspace?: Promise<Workspace.Handle>
  }

  const sessions = new Map<SessionID, State>()

  export function activate(opts: Options) {
    if (sessions.has(opts.sessionID)) throw new Error(`Auto Mode session is already active: ${opts.sessionID}`)
    sessions.set(opts.sessionID, { ...opts })
  }

  export async function deactivate(sessionID: SessionID) {
    const state = sessions.get(sessionID)
    sessions.delete(sessionID)
    await state?.workspace?.then((workspace) => workspace.cleanup())
  }

  function action(
    input: { sessionID: SessionID; callID?: string; tool: string },
    effects: readonly ActionEffect[],
  ): Action {
    const callID = input.callID ?? `missing-${input.tool}`
    return {
      sessionID: input.sessionID,
      callID,
      actionID: createActionID({ sessionID: input.sessionID, callID }),
      tool: input.tool,
      effects: [...effects],
    }
  }

  function denied(action: Action, decision: Decision) {
    if (decision.verdict === "ALLOW") throw new Error("Cannot create an Auto Mode denial from an ALLOW decision")
    return new Denied({
      actionID: action.actionID,
      tool: action.tool,
      phase: decision.phase,
      verdict: decision.verdict,
      ruleCodes: decision.ruleCodes,
      summary: decision.summary,
    })
  }

  function paths(effects: readonly ActionEffect[]) {
    const values = effects.flatMap((effect) => (effect.path ? [effect.path] : []))
    return values.length ? [...new Set(values)] : ["*"]
  }

  function review(ctx: Tool.Context, decision: Decision, effects: readonly ActionEffect[]) {
    return ctx.ask({
      permission: effects.some((effect) => effect.category !== "file.read") ? "edit" : "read",
      patterns: paths(effects),
      always: paths(effects),
      metadata: { autoMode: true, ruleCodes: decision.ruleCodes },
    })
  }

  function result(action: Action, effects: readonly ActionEffect[]) {
    return { ...action, effects: [...effects] }
  }

  function restore<A>(value: A, shadow: string, root: string): A {
    if (typeof value === "string") return value.split(shadow).join(root) as A
    if (Array.isArray(value)) return value.map((item) => restore(item, shadow, root)) as A
    if (typeof value !== "object" || value == null) return value
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restore(item, shadow, root)])) as A
  }

  export function execute<A, O, E, R>(input: {
    tool: string
    args: A
    ctx: Tool.Context
    run: (args: A, ctx: Tool.Context) => Effect.Effect<O, E, R>
  }) {
    return Effect.gen(function* () {
      const state = sessions.get(input.ctx.sessionID)
      if (!state) return yield* input.run(input.args, input.ctx)

      const prestart = performance.now()
      const adapter = yield* Effect.tryPromise({
        try: () =>
          Adapter.assess(Adapter.resolve(input.tool, input.args, state.root), {
            root: state.root,
            checker: state.packageChecker,
            timeout: state.packageTimeout,
            signal: input.ctx.abort,
          }),
        catch: (cause) => new Error("Auto Mode package assessment failed", { cause }),
      })
      const current = action(
        { sessionID: input.ctx.sessionID, callID: input.ctx.callID, tool: input.tool },
        adapter.effects,
      )
      const env = yield* Effect.context<R>()
      const instance = yield* InstanceState.context
      const bridge = yield* EffectBridge.make()
      const publish = state.audit ?? ((event: Audit.Input) => bridge.promise(Audit.publish(event)))
      const send = async (event: Audit.Input) => {
        await state.record?.(event)
        // kilocode_change start - bus fan-out is observability only: the JSONL record above is the audit
        // of record and stays fatal; a bus failure must not turn every tool call into an error.
        try {
          return await publish(event)
        } catch {
          return undefined
        }
        // kilocode_change end
      }
      const emit = (event: Audit.Input) =>
        Effect.tryPromise({
          try: () => send(event),
          catch: (cause) => new Error("Auto Mode audit failed", { cause }),
        })
      const workspace = () =>
        (state.workspace ??= Workspace.create({
          root: state.root,
          sessionID: state.sessionID,
          temp: state.temp,
          audit: send,
        }))

      yield* emit({ action: current, phase: "received", timestamp: Date.now() })
      const pre = Policy.evaluate({
        phase: "pre",
        tool: input.tool,
        adapter: adapter.kind === "unsupported" ? "unsupported" : "supported",
        root: state.root,
        effects: current.effects,
      })
      yield* emit({
        action: current,
        phase: "precheck",
        timestamp: Date.now(),
        decision: pre,
        duration: Math.max(0, Math.round(performance.now() - prestart)),
      })

      const approval = { reviewed: false }
      const run = Effect.gen(function* () {
        if (pre.verdict === "DENY") {
          yield* emit({ action: current, phase: "discarded", timestamp: Date.now(), decision: pre })
          return yield* Effect.fail(denied(current, pre))
        }
        if (pre.verdict === "ASK") {
          const answer = yield* Effect.exit(review(input.ctx, pre, current.effects))
          if (Exit.isFailure(answer)) {
            yield* emit({ action: current, phase: "discarded", timestamp: Date.now(), decision: pre })
            return yield* Effect.fail(denied(current, pre))
          }
          approval.reviewed = true
        }

        if (adapter.kind === "read") {
          const start = performance.now()
          const output = yield* input.run(input.args, input.ctx)
          yield* emit({
            action: current,
            phase: "applied",
            timestamp: Date.now(),
            duration: Math.max(0, Math.round(performance.now() - start)),
          })
          return output
        }
        if (adapter.kind === "unsupported") return yield* Effect.fail(denied(current, pre))

        const handle = yield* Effect.tryPromise({
          try: workspace,
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        })
        return yield* Effect.tryPromise({
          try: () =>
            handle.transaction(
              current,
              async (tx) => {
                const declared = [...current.effects]
                const args = Adapter.rewrite(input.tool, input.args, state.root, tx.root)
                const ctx: Tool.Context = {
                  ...input.ctx,
                  extra: {
                    ...input.ctx.extra,
                    autoMode: input.tool === "bash",
                    autoRoot: state.root,
                    autoShadow: tx.root,
                    sandboxed: false,
                  },
                  ask: (req) => {
                    declared.push(...Adapter.asked(req))
                    return input.ctx.ask({
                      ...req,
                      metadata: { ...req.metadata, autoModeTrial: true },
                    })
                  },
                }
                const scope = { ...instance, directory: tx.root, worktree: tx.root }
                const start = performance.now()
                const output = await Instance.restore(scope, () =>
                  Effect.runPromise(
                    input.run(args, ctx).pipe(Effect.provide(env), Effect.provideService(InstanceRef, scope)),
                  ),
                )
                await send({
                  action: result(current, declared),
                  phase: "trial_finished",
                  timestamp: Date.now(),
                  duration: Math.max(0, Math.round(performance.now() - start)),
                })
                const observing = performance.now()
                const observed = await tx.observe()
                const observedAction = result(current, observed.effects)
                await send({
                  action: observedAction,
                  phase: "observed",
                  timestamp: Date.now(),
                  duration: Math.max(0, Math.round(performance.now() - observing)),
                })
                const checking = performance.now()
                const post = Policy.evaluate({
                  phase: "post",
                  tool: input.tool,
                  adapter: "supported",
                  root: state.root,
                  effects: observed.effects,
                  declared,
                })
                await send({
                  action: observedAction,
                  phase: "postcheck",
                  timestamp: Date.now(),
                  decision: post,
                  duration: Math.max(0, Math.round(performance.now() - checking)),
                })
                if (post.verdict === "DENY") {
                  await tx.discard(observed, post)
                  throw denied(current, post)
                }
                if (post.verdict === "ASK") {
                  const answer = await Effect.runPromiseExit(
                    review(ctx, post, observed.effects).pipe(Effect.provide(env)),
                  )
                  if (Exit.isFailure(answer)) {
                    await tx.discard(observed, post)
                    throw denied(current, post)
                  }
                }
                const applied = await tx.apply(observed)
                if (applied.status === "conflict") {
                  await Effect.runPromiseExit(review(ctx, applied.decision, observed.effects).pipe(Effect.provide(env)))
                  throw denied(current, applied.decision)
                }
                return restore(output, tx.root, state.root)
              },
              input.ctx.abort,
            ),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        })
      })

      const exit = yield* Effect.exit(run)
      if (adapter.kind === "read" && Exit.isFailure(exit) && (pre.verdict === "ALLOW" || approval.reviewed)) {
        yield* emit({ action: current, phase: "failed", timestamp: Date.now(), error: new Error("Read action failed") })
      }
      yield* emit({
        action: current,
        phase: "returned_to_agent",
        timestamp: Date.now(),
        error: Exit.isFailure(exit) ? new Error("Auto Mode action failed") : undefined,
      })
      return yield* exit
    })
  }
}
