import { afterEach, describe, expect, test } from "bun:test"
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type * as Audit from "../../../src/kilocode/auto/audit"
import { Copy } from "../../../src/kilocode/auto/copy"
import { Manifest } from "../../../src/kilocode/auto/manifest"
import { createActionID, type Action } from "../../../src/kilocode/auto/types"
import { Workspace } from "../../../src/kilocode/auto/workspace"
import { SessionID } from "../../../src/session/schema"

const roots: string[] = []
const sessionID = SessionID.make("ses_auto_workspace_test")

async function temp(prefix: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  roots.push(dir)
  return dir
}

async function setup(backend?: Copy.Backend) {
  const root = await temp("kilo-auto-original-")
  const storage = await temp("kilo-auto-storage-")
  const events: Audit.Input[] = []
  const workspace = await Workspace.create({
    root,
    sessionID,
    temp: storage,
    backend,
    audit: async (event) => {
      events.push(event)
    },
  })
  return { root, storage, workspace, events }
}

function action(callID: string): Action {
  return {
    sessionID,
    callID,
    actionID: createActionID({ sessionID, callID }),
    tool: "write",
    effects: [],
  }
}

function entries(info: Manifest.Info) {
  return info.entries.map((entry) => ({ ...entry, path: entry.path }))
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("Auto Mode shadow workspace", () => {
  test("keeps original unchanged before verdict and applies the exact observed change set", async () => {
    const root = await temp("kilo-auto-original-")
    await mkdir(path.join(root, ".git"))
    await writeFile(path.join(root, ".git/index"), "private git data")
    await writeFile(path.join(root, ".gitignore"), "ignored.txt\n")
    await writeFile(path.join(root, "changed.txt"), "before")
    await writeFile(path.join(root, "deleted.txt"), "delete")
    const storage = await temp("kilo-auto-storage-")
    const events: Audit.Input[] = []
    const workspace = await Workspace.create({
      root,
      sessionID,
      temp: storage,
      audit: async (event) => {
        events.push(event)
      },
    })

    expect(await lstat(path.join(workspace.root, ".git")).catch(() => undefined)).toBeUndefined()
    const before = await Manifest.capture({ root })
    await workspace.transaction(action("safe-apply"), async (tx) => {
      await writeFile(path.join(tx.root, "changed.txt"), "after")
      await unlink(path.join(tx.root, "deleted.txt"))
      await writeFile(path.join(tx.root, "ignored.txt"), Buffer.from([0, 1, 2, 255]))
      await writeFile(path.join(tx.root, "tool.sh"), "#!/bin/sh\n")
      await chmod(path.join(tx.root, "tool.sh"), 0o755)
      await symlink("changed.txt", path.join(tx.root, "link"))

      expect(entries(await Manifest.capture({ root }))).toEqual(entries(before))
      const observed = await tx.observe()
      expect(observed.diagnostics).toEqual([])
      expect((await tx.apply(observed)).status).toBe("applied")
    })

    expect(await readFile(path.join(root, "changed.txt"), "utf8")).toBe("after")
    expect(await readFile(path.join(root, "ignored.txt"))).toEqual(Buffer.from([0, 1, 2, 255]))
    expect(await lstat(path.join(root, "deleted.txt")).catch(() => undefined)).toBeUndefined()
    expect((await lstat(path.join(root, "tool.sh"))).mode & 0o111).not.toBe(0)
    expect((await lstat(path.join(root, "link"))).isSymbolicLink()).toBe(true)
    expect(entries(await Manifest.capture({ root }))).toEqual(entries(await Manifest.capture({ root: workspace.root })))
    expect(events.map((event) => event.phase)).toEqual(["trial_started", "applied"])
    expect(events.every((event) => event.duration == null || event.duration >= 0)).toBe(true)
    expect(JSON.stringify(events)).not.toContain(storage)
    expect(workspace.root.startsWith(storage + path.sep)).toBe(true)
    await workspace.cleanup()
  })

  test("discard restores ignored files in shadow and leaves original at baseline", async () => {
    const root = await temp("kilo-auto-original-")
    await writeFile(path.join(root, ".gitignore"), "ignored.txt\n")
    await writeFile(path.join(root, "ignored.txt"), "baseline")
    const storage = await temp("kilo-auto-storage-")
    const events: Audit.Input[] = []
    const workspace = await Workspace.create({
      root,
      sessionID,
      temp: storage,
      audit: async (event) => {
        events.push(event)
      },
    })

    await workspace.transaction(action("discard"), async (tx) => {
      await writeFile(path.join(tx.root, "ignored.txt"), "denied")
      await writeFile(path.join(tx.root, "extra.txt"), "denied")
      await tx.discard()
    })

    expect(await readFile(path.join(root, "ignored.txt"), "utf8")).toBe("baseline")
    expect(await readFile(path.join(workspace.root, "ignored.txt"), "utf8")).toBe("baseline")
    expect(await lstat(path.join(workspace.root, "extra.txt")).catch(() => undefined)).toBeUndefined()
    expect(events.map((event) => event.phase)).toEqual(["trial_started", "discarded"])
    await workspace.cleanup()
  })

  test("detects a concurrent original edit without overwriting it and resynchronizes shadow", async () => {
    const { root, workspace } = await setup()
    await writeFile(path.join(root, "file.txt"), "baseline")

    const result = await workspace.transaction(action("conflict"), async (tx) => {
      await writeFile(path.join(tx.root, "file.txt"), "agent")
      const observed = await tx.observe()
      await writeFile(path.join(root, "file.txt"), "user")
      return tx.apply(observed)
    })

    expect(result.status).toBe("conflict")
    if (result.status === "conflict") expect(result.decision.ruleCodes).toContain("AUTO_APPLY_CONFLICT")
    expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe("user")
    expect(await readFile(path.join(workspace.root, "file.txt"), "utf8")).toBe("user")
    await workspace.cleanup()
  })

  test("rolls back every applied path when a later copy fails", async () => {
    const backend: Copy.Backend = {
      tree: Copy.local.tree,
      async entry(source, target) {
        if (source.includes(`${path.sep}shadow${path.sep}`) && source.endsWith(`${path.sep}b.txt`)) {
          throw new globalThis.Error("injected apply failure")
        }
        await Copy.local.entry(source, target)
      },
    }
    const root = await temp("kilo-auto-original-")
    await writeFile(path.join(root, "a.txt"), "a-before")
    await writeFile(path.join(root, "b.txt"), "b-before")
    const storage = await temp("kilo-auto-storage-")
    const workspace = await Workspace.create({ root, sessionID, temp: storage, backend, audit: async () => undefined })

    await expect(
      workspace.transaction(action("rollback"), async (tx) => {
        await writeFile(path.join(tx.root, "a.txt"), "a-after")
        await writeFile(path.join(tx.root, "b.txt"), "b-after")
        await tx.apply(await tx.observe())
      }),
    ).rejects.toMatchObject({ code: "AUTO_APPLY_FAILED" })
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("a-before")
    expect(await readFile(path.join(root, "b.txt"), "utf8")).toBe("b-before")
    await workspace.cleanup()
  })

  test("rejects a symlink escape and cleanup never follows it", async () => {
    const { root, workspace } = await setup()
    const outside = await temp("kilo-auto-outside-")
    await writeFile(path.join(outside, "sentinel"), "safe")

    await expect(
      workspace.transaction(action("escape"), async (tx) => {
        await symlink(path.join(outside, "sentinel"), path.join(tx.root, "escape"))
        await tx.apply(await tx.observe())
      }),
    ).rejects.toMatchObject({ code: "AUTO_OUTSIDE_WORKSPACE" })
    expect(await lstat(path.join(root, "escape")).catch(() => undefined)).toBeUndefined()
    await workspace.cleanup()
    expect(await readFile(path.join(outside, "sentinel"), "utf8")).toBe("safe")
  })

  test("serializes concurrent mutation transactions", async () => {
    const { workspace } = await setup()
    const entered: string[] = []
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const first = workspace.transaction(action("first"), async () => {
      entered.push("first")
      started.resolve()
      await release.promise
    })
    await started.promise
    const second = workspace.transaction(action("second"), async () => {
      entered.push("second")
    })
    await Bun.sleep(10)
    expect(entered).toEqual(["first"])
    release.resolve()
    await Promise.all([first, second])
    expect(entered).toEqual(["first", "second"])
    await workspace.cleanup()
  })

  test("fails closed when the initial workspace contains an escaping symlink", async () => {
    const root = await temp("kilo-auto-original-")
    const storage = await temp("kilo-auto-storage-")
    await symlink("../outside", path.join(root, "escape"))
    await expect(Workspace.create({ root, sessionID, temp: storage, audit: async () => undefined })).rejects.toThrow(
      "escaping symlink",
    )
  })
})
