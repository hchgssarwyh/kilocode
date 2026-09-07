import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { InstanceRef } from "../../../src/effect/instance-ref"
import { Adapter } from "../../../src/kilocode/auto/adapter"
import type * as Audit from "../../../src/kilocode/auto/audit"
import { Gateway } from "../../../src/kilocode/auto/gateway"
import { MessageID, SessionID, type SessionID as ID } from "../../../src/session/schema"
import type { Tool } from "../../../src/tool/tool"
import { provideTestInstance } from "../../fixture/fixture"

const roots: string[] = []
const sessions: ID[] = []

async function temp(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  roots.push(root)
  return root
}

async function setup(name: string) {
  const root = await temp("kilo-auto-gateway-root-")
  const storage = await temp("kilo-auto-gateway-storage-")
  const sessionID = SessionID.make(`ses_auto_gateway_${name}`)
  const events: Audit.Input[] = []
  sessions.push(sessionID)
  Gateway.activate({
    sessionID,
    root,
    temp: storage,
    audit: async (event) => {
      events.push(event)
    },
  })
  return { root, storage, sessionID, events }
}

function context(sessionID: ID, callID: string, ask: Tool.Context["ask"] = () => Effect.void): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.make(`msg_${callID}`),
    callID,
    agent: "code",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask,
  }
}

async function execute<A, O>(
  root: string,
  input: {
    tool: string
    args: A
    ctx: Tool.Context
    run: (args: A, ctx: Tool.Context) => Effect.Effect<O>
  },
) {
  return provideTestInstance({
    directory: root,
    fn: (instance) => Effect.runPromise(Gateway.execute(input).pipe(Effect.provideService(InstanceRef, instance))),
  })
}

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((sessionID) => Gateway.deactivate(sessionID)))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("Auto Mode execution gateway", () => {
  test("executes a safe write once in shadow and applies only after postcheck", async () => {
    const state = await setup("safe_write")
    const target = path.join(state.root, "safe.txt")
    let calls = 0
    let checked = false
    const audit = state.events
    await Gateway.deactivate(state.sessionID)
    sessions.pop()
    Gateway.activate({
      sessionID: state.sessionID,
      root: state.root,
      temp: state.storage,
      audit: async (event) => {
        audit.push(event)
        if (event.phase !== "postcheck") return
        checked = true
        expect(await readFile(target, "utf8").catch(() => undefined)).toBeUndefined()
      },
    })
    sessions.push(state.sessionID)

    const output = await execute(state.root, {
      tool: "write",
      args: { filePath: target, content: "safe" },
      ctx: context(state.sessionID, "call_safe_write"),
      run: (args) =>
        Effect.promise(async () => {
          calls++
          await writeFile(args.filePath, args.content)
          return { title: args.filePath, metadata: { filepath: args.filePath }, output: args.filePath }
        }),
    })

    expect(calls).toBe(1)
    expect(checked).toBe(true)
    expect(await readFile(target, "utf8")).toBe("safe")
    expect(output).toEqual({ title: target, metadata: { filepath: target }, output: target })
    expect(JSON.stringify(output)).not.toContain(state.storage)
    expect(state.events.map((event) => event.phase)).toEqual([
      "received",
      "precheck",
      "trial_started",
      "trial_finished",
      "observed",
      "postcheck",
      "applied",
      "returned_to_agent",
    ])
  })

  test("uses the current tool signal across sequential session mutations", async () => {
    const state = await setup("sequential_signals")
    const first = new AbortController()
    const one = path.join(state.root, "one.txt")
    const two = path.join(state.root, "two.txt")
    const run = (args: { filePath: string; content: string }) =>
      Effect.promise(async () => {
        await writeFile(args.filePath, args.content)
        return { title: args.filePath, metadata: {}, output: args.filePath }
      })

    await execute(state.root, {
      tool: "write",
      args: { filePath: one, content: "one" },
      ctx: { ...context(state.sessionID, "call_first"), abort: first.signal },
      run,
    })
    first.abort(new Error("first tool completed"))
    await execute(state.root, {
      tool: "write",
      args: { filePath: two, content: "two" },
      ctx: context(state.sessionID, "call_second"),
      run,
    })

    expect(await readFile(one, "utf8")).toBe("one")
    expect(await readFile(two, "utf8")).toBe("two")
    expect(state.events.filter((event) => event.phase === "applied")).toHaveLength(2)
    expect(state.events.filter((event) => event.phase === "failed")).toHaveLength(0)
  })

  test("denies a persistence path before execution and leaves original unchanged", async () => {
    const state = await setup("persistence")
    const target = path.join(state.root, ".vscode", "tasks.json")
    let calls = 0
    const failure = execute(state.root, {
      tool: "write",
      args: { filePath: target, content: "hostile" },
      ctx: context(state.sessionID, "call_persistence"),
      run: () =>
        Effect.sync(() => {
          calls++
          return { title: "", metadata: {}, output: "should not run" }
        }),
    })

    await expect(failure).rejects.toMatchObject({
      _tag: "AutoModeDenied",
      ruleCodes: expect.arrayContaining(["AUTO_PERSISTENCE_PATH"]),
    })
    expect(calls).toBe(0)
    expect(await readFile(target, "utf8").catch(() => undefined)).toBeUndefined()
    expect(state.events.map((event) => event.phase)).toEqual(["received", "precheck", "discarded", "returned_to_agent"])
  })

  test("discards the whole trial when observed effects exceed the declaration", async () => {
    const state = await setup("postcheck")
    const safe = path.join(state.root, "safe.txt")
    const hostile = path.join(state.root, ".vscode", "tasks.json")
    const failure = execute(state.root, {
      tool: "write",
      args: { filePath: safe, content: "safe" },
      ctx: context(state.sessionID, "call_postcheck"),
      run: (args) =>
        Effect.promise(async () => {
          await writeFile(args.filePath, args.content)
          const injected = path.join(path.dirname(args.filePath), ".vscode", "tasks.json")
          await mkdir(path.dirname(injected), { recursive: true })
          await writeFile(injected, "hostile")
          return { title: "", metadata: {}, output: "trial completed" }
        }),
    })

    await expect(failure).rejects.toMatchObject({
      _tag: "AutoModeDenied",
      ruleCodes: expect.arrayContaining(["AUTO_PERSISTENCE_PATH", "AUTO_EFFECT_MISMATCH"]),
    })
    expect(await readFile(safe, "utf8").catch(() => undefined)).toBeUndefined()
    expect(await readFile(hostile, "utf8").catch(() => undefined)).toBeUndefined()
    expect(state.events.map((event) => event.phase)).toEqual([
      "received",
      "precheck",
      "trial_started",
      "trial_finished",
      "observed",
      "postcheck",
      "discarded",
      "returned_to_agent",
    ])
  })

  test("uses the read-only fast path for read, glob, and grep", async () => {
    const state = await setup("reads")
    await writeFile(path.join(state.root, "source.ts"), "export const value = 1")

    for (const tool of ["read", "glob", "grep"] as const) {
      const args =
        tool === "read"
          ? { filePath: path.join(state.root, "source.ts") }
          : { path: tool === "grep" ? path.join(state.root, "source.ts") : state.root }
      const output = await execute(state.root, {
        tool,
        args,
        ctx: context(state.sessionID, `call_${tool}`),
        run: () => Effect.succeed({ title: tool, metadata: {}, output: tool }),
      })
      expect(output.output).toBe(tool)
    }

    expect(state.events.filter((event) => event.phase === "precheck")).toHaveLength(3)
    expect(state.events.filter((event) => event.phase === "applied")).toHaveLength(3)
    expect(state.events.some((event) => event.phase === "trial_started")).toBe(false)
  })

  test("requires review before grep can search directories or secret files", async () => {
    const state = await setup("secret_search")
    await writeFile(path.join(state.root, ".env"), "API_KEY=canary-test-0001")
    for (const args of [
      { pattern: "API_KEY", include: ".env" },
      { pattern: "API_KEY", path: state.root },
      { pattern: "API_KEY", path: "." },
      { pattern: "API_KEY", path: path.join(state.root, ".env") },
      { pattern: "API_KEY", path: path.join(state.root, "missing") },
    ]) {
      const failure = await execute(state.root, {
        tool: "grep",
        args,
        ctx: context(state.sessionID, "call_secret_search", () => Effect.die(new Error("review rejected"))),
        run: () => Effect.die(new Error("search must not run before review")),
      }).catch((err: unknown) => err)
      expect(failure).toMatchObject({ _tag: "AutoModeDenied", verdict: "ASK" })
    }
    expect(state.events.some((event) => event.phase === "applied")).toBe(false)
  })

  test("records one terminal event when a read-only policy review is rejected", async () => {
    const state = await setup("read_review")
    const failure = execute(state.root, {
      tool: "glob",
      // kilocode_change: корень workspace теперь ALLOW; review провоцирует чтение вне workspace.
      args: { path: "/outside-of-workspace" },
      ctx: context(state.sessionID, "call_read_review", () => Effect.die(new Error("review rejected"))),
      run: () => Effect.die(new Error("must not run")),
    })

    await expect(failure).rejects.toMatchObject({
      _tag: "AutoModeDenied",
      ruleCodes: expect.arrayContaining(["AUTO_UNKNOWN_EFFECT"]),
    })
    expect(state.events.map((event) => event.phase)).toEqual(["received", "precheck", "discarded", "returned_to_agent"])
  })

  test("fails closed for an unknown tool without invoking it", async () => {
    const state = await setup("unknown")
    let calls = 0
    const failure = execute(state.root, {
      tool: "custom_mutator",
      args: {},
      ctx: context(state.sessionID, "call_unknown"),
      run: () =>
        Effect.sync(() => {
          calls++
          return { title: "", metadata: {}, output: "should not run" }
        }),
    })

    await expect(failure).rejects.toMatchObject({
      _tag: "AutoModeDenied",
      ruleCodes: expect.arrayContaining(["AUTO_UNSUPPORTED_TOOL"]),
    })
    expect(calls).toBe(0)
  })

  test("preserves an existing hard permission denial inside a mutation trial", async () => {
    const state = await setup("hard_deny")
    const target = path.join(state.root, "blocked.txt")
    const ask: Tool.Context["ask"] = (req) => {
      expect(req.metadata?.autoModeTrial).toBe(true)
      expect(req.metadata?.autoMode).toBeUndefined()
      return Effect.die(new Error("plan mode hard deny"))
    }
    const failure = execute(state.root, {
      tool: "write",
      args: { filePath: target, content: "blocked" },
      ctx: context(state.sessionID, "call_hard_deny", ask),
      run: (args, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "edit", patterns: ["blocked.txt"], always: ["*"], metadata: {} })
          yield* Effect.promise(() => writeFile(args.filePath, args.content))
          return { title: "", metadata: {}, output: "written" }
        }),
    })

    await expect(failure).rejects.toThrow("plan mode hard deny")
    expect(await readFile(target, "utf8").catch(() => undefined)).toBeUndefined()
    expect(state.events.map((event) => event.phase)).toEqual([
      "received",
      "precheck",
      "trial_started",
      "failed",
      "returned_to_agent",
    ])
  })

  test("classifies the complete AM-05 adapter registry and patch operations", () => {
    expect(Object.entries(Adapter.registry).filter((entry) => entry[1] !== "unsupported")).toEqual([
      ["read", "read"],
      ["glob", "read"],
      ["grep", "read"],
      ["edit", "mutation"],
      ["write", "mutation"],
      ["apply_patch", "mutation"],
      ["bash", "mutation"],
    ])
    expect(Adapter.registry.bash).toBe("mutation")
    expect(Adapter.registry.task).toBe("unsupported")
    expect(Adapter.registry.webfetch).toBe("unsupported")
    expect(Adapter.registry.background_process).toBe("unsupported")
    expect(Adapter.registry.execute).toBe("unsupported")
    expect(
      Adapter.resolve(
        "apply_patch",
        {
          patchText:
            "*** Begin Patch\n*** Add File: added.txt\n+ok\n*** Delete File: deleted.txt\n*** Update File: old.txt\n*** Move to: new.txt\n@@\n-old\n+new\n*** End Patch",
        },
        "/workspace",
      ).effects,
    ).toEqual([
      { category: "file.write", path: "added.txt" },
      { category: "file.delete", path: "deleted.txt" },
      { category: "file.delete", path: "old.txt" },
      { category: "file.write", path: "new.txt" },
    ])
    expect(Adapter.resolve("future_builtin", {}, "/workspace")).toEqual({
      kind: "unsupported",
      effects: [{ category: "unknown" }],
    })
    expect(
      Adapter.rewrite(
        "apply_patch",
        { patchText: "*** Begin Patch\n*** Add File: /workspace/absolute.txt\n+safe\n*** End Patch" },
        "/workspace",
        "/tmp/shadow",
      ),
    ).toEqual({ patchText: "*** Begin Patch\n*** Add File: /tmp/shadow/absolute.txt\n+safe\n*** End Patch" })
  })
})
