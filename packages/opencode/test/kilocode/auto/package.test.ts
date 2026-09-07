import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { InstanceRef } from "../../../src/effect/instance-ref"
import { Adapter } from "../../../src/kilocode/auto/adapter"
import type * as Audit from "../../../src/kilocode/auto/audit"
import { Gateway } from "../../../src/kilocode/auto/gateway"
import * as Package from "../../../src/kilocode/auto/package"
import { Policy } from "../../../src/kilocode/auto/policy"
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

function context(sessionID: ID, callID: string): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.make(`msg_${callID}`),
    callID,
    agent: "code",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

async function inspect(root: string, command: string, checker?: Package.Checker, timeout?: number) {
  const info = Adapter.resolve("bash", { command }, root)
  return Adapter.assess(info, { root, checker, timeout })
}

async function setup(name: string, checker?: Package.Checker) {
  const root = await temp("kilo-auto-package-root-")
  const storage = await temp("kilo-auto-package-storage-")
  const sessionID = SessionID.make(`ses_auto_package_${name}`)
  const events: Audit.Input[] = []
  sessions.push(sessionID)
  Gateway.activate({
    sessionID,
    root,
    temp: storage,
    packageChecker: checker,
    audit: async (event) => {
      events.push(event)
    },
  })
  return { root, sessionID, events }
}

async function execute(state: Awaited<ReturnType<typeof setup>>, callID: string, hostile = false) {
  return provideTestInstance({
    directory: state.root,
    fn: (instance) =>
      Effect.runPromise(
        Gateway.execute({
          tool: "bash",
          args: { command: "npm install stable", workdir: undefined as string | undefined },
          ctx: context(state.sessionID, callID),
          run: (args) =>
            Effect.promise(async () => {
              const cwd = args.workdir ?? state.root
              await writeFile(path.join(cwd, "package-lock.json"), '{"lockfileVersion":3}')
              await writeFile(path.join(cwd, "artifact.txt"), "installed")
              if (hostile) {
                await mkdir(path.join(cwd, ".vscode"), { recursive: true })
                await writeFile(path.join(cwd, ".vscode", "tasks.json"), '{"version":"2.0.0"}')
              }
              return { title: "npm", metadata: {}, output: "installed" }
            }),
        }).pipe(Effect.provideService(InstanceRef, instance)),
      ),
  })
}

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((sessionID) => Gateway.deactivate(sessionID)))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("Auto Mode package classification", () => {
  test("normalizes supported managers, operations, names, specs, manifests, and lockfiles", async () => {
    const root = await temp("kilo-auto-package-classify-")
    await writeFile(path.join(root, "package.json"), '{"dependencies":{"lodash":"^4.17.21"}}')
    await writeFile(path.join(root, "package-lock.json"), '{"lockfileVersion":3}')

    const npm = await inspect(root, "npm install lodash@^4.17.21")
    expect(npm.effects.at(1)?.package).toEqual({
      manager: "npm",
      operation: "install",
      name: "lodash",
      spec: "^4.17.21",
      status: "existing",
      manifests: ["package.json"],
      locks: ["package-lock.json"],
    })
    expect(
      Policy.evaluate({ phase: "pre", tool: "bash", adapter: "supported", root, effects: npm.effects }),
    ).toMatchObject({ verdict: "ALLOW", ruleCodes: [] })

    const cases = [
      ["bun add hono", "bun", "add", "bun.lock"],
      ["pnpm update zod", "pnpm", "update", "pnpm-lock.yaml"],
      ["yarn remove react", "yarn", "remove", "yarn.lock"],
    ] as const
    for (const [command, manager, operation, lock] of cases) {
      const info = await inspect(root, command)
      expect(info.effects.at(1)?.package).toMatchObject({ manager, operation, status: "unknown", locks: [lock] })
    }

    const implicit = await inspect(root, "yarn --immutable")
    expect(implicit.effects.at(1)?.package).toMatchObject({ manager: "yarn", operation: "install" })
    const ci = await inspect(root, "npm ci")
    expect(ci.effects.at(1)?.package).toMatchObject({ manager: "npm", operation: "install", status: "existing" })
    const corepack = await inspect(root, "corepack pnpm add hono")
    expect(corepack.effects.at(1)?.package).toMatchObject({ manager: "pnpm", operation: "add", name: "hono" })
    expect((await inspect(root, "make install")).effects).toHaveLength(1)
  })

  test("uses trusted metadata only for new packages and never turns a new package into auto-allow", async () => {
    const root = await temp("kilo-auto-package-checker-")
    await writeFile(path.join(root, "package.json"), '{"dependencies":{"stable":"1.0.0"}}')
    const queries: string[] = []
    const checker: Package.Checker = async (query) => {
      queries.push(query.name)
      return { status: query.name === "lodahs" ? "typo" : "known", canonical: "lodash" }
    }

    const known = await inspect(root, "npm install stable", checker)
    const fresh = await inspect(root, "npm install lodash", checker)
    const typo = await inspect(root, "npm install lodahs", checker)

    expect(known.effects.at(1)?.package?.status).toBe("existing")
    expect(fresh.effects.at(1)?.package?.status).toBe("new")
    expect(typo.effects.at(1)?.package?.status).toBe("suspicious")
    expect(queries).toEqual(["lodash", "lodahs"])
    for (const info of [fresh, typo]) {
      expect(
        Policy.evaluate({ phase: "pre", tool: "bash", adapter: "supported", root, effects: info.effects }),
      ).toMatchObject({ verdict: "ASK", ruleCodes: ["AUTO_PACKAGE_INSTALL"] })
    }
  })

  test("keeps direct sources, confusable names, unsupported managers, and metadata failures fail-closed", async () => {
    const root = await temp("kilo-auto-package-risk-")
    await writeFile(path.join(root, "package.json"), "{}")
    let calls = 0
    const checker: Package.Checker = async () => {
      calls++
      return { status: "known" }
    }

    for (const command of [
      "npm install https://user:token@example.test/pkg.tgz",
      "npm install git+ssh://git@example.test/repo.git",
      "npm install ../local-package",
      "npm install lоdash",
    ]) {
      const info = await inspect(root, command, checker)
      expect(info.effects.at(1)?.package).toMatchObject({ status: "suspicious" })
      expect(JSON.stringify(info.effects)).not.toContain("token@example")
    }
    expect(calls).toBe(0)

    await writeFile(path.join(root, "package.json"), '{"dependencies":{"lоdash":"1.0.0"}}')
    expect((await inspect(root, "npm install lоdash", checker)).effects.at(1)?.package?.status).toBe("suspicious")

    const pip = await inspect(root, "pip install requests", checker)
    expect(
      Policy.evaluate({ phase: "pre", tool: "bash", adapter: "supported", root, effects: pip.effects }),
    ).toMatchObject({
      verdict: "DENY",
      ruleCodes: ["AUTO_PACKAGE_MANAGER_UNSUPPORTED", "AUTO_PACKAGE_INSTALL"],
    })

    const pending = Promise.withResolvers<Package.Metadata>()
    const timeout = await inspect(root, "npm install timeout-package", () => pending.promise, 5)
    expect(timeout.effects.at(1)?.package?.status).toBe("unknown")

    const invalid = await inspect(root, "npm install invalid-response", async () => ({ status: "ALLOW" }) as never)
    expect(invalid.effects.at(1)?.package?.status).toBe("unknown")
  })
})

describe("Auto Mode package transaction", () => {
  test("applies manifest-adjacent install results as one shadow action", async () => {
    const state = await setup("apply")
    await writeFile(path.join(state.root, "package.json"), '{"dependencies":{"stable":"1.0.0"}}')

    await execute(state, "call_apply")

    expect(await readFile(path.join(state.root, "artifact.txt"), "utf8")).toBe("installed")
    expect(await readFile(path.join(state.root, "package-lock.json"), "utf8")).toContain("lockfileVersion")
    expect(state.events.find((event) => event.phase === "precheck")?.action.effects.at(1)?.package).toMatchObject({
      name: "stable",
      status: "existing",
    })
    expect(state.events.map((event) => event.phase)).toContain("applied")
  })

  test("discards the complete install when a lifecycle effect creates persistence", async () => {
    const state = await setup("discard")
    await writeFile(path.join(state.root, "package.json"), '{"dependencies":{"stable":"1.0.0"}}')

    await expect(execute(state, "call_discard", true)).rejects.toMatchObject({
      _tag: "AutoModeDenied",
      ruleCodes: expect.arrayContaining(["AUTO_PERSISTENCE_PATH"]),
    })
    expect(await readFile(path.join(state.root, "artifact.txt"), "utf8").catch(() => undefined)).toBeUndefined()
    expect(await readFile(path.join(state.root, "package-lock.json"), "utf8").catch(() => undefined)).toBeUndefined()
    expect(
      await readFile(path.join(state.root, ".vscode", "tasks.json"), "utf8").catch(() => undefined),
    ).toBeUndefined()
    expect(state.events.map((event) => event.phase)).toContain("discarded")
  })
})

test("marks a package typo as suspicious", async () => {
  const root = await temp("package-typo")

  const effects = Package.classify(
    "npm",
    ["install", "lodahs"],
    root,
  )

  const assessed = await Package.assess(
    effects,
    {
      root,
      checker: async ({ name }) => {
        expect(name).toBe("lodahs")

        return {
          status: "typo",
          canonical: "lodash",
        }
      },
    },
  )

  expect(assessed).toEqual([
    expect.objectContaining({
      category: "package.install",
      package: expect.objectContaining({
        name: "lodahs",
        canonical: "lodash",
        status: "suspicious",
      }),
    }),
  ])
})

