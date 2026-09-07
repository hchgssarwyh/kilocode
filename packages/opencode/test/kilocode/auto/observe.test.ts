import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Manifest } from "../../../src/kilocode/auto/manifest"
import { Observe } from "../../../src/kilocode/auto/observe"
import { Policy } from "../../../src/kilocode/auto/policy"

const roots: string[] = []

async function root() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kilo-auto-observe-"))
  roots.push(dir)
  return dir
}

async function capture(dir: string, opts: Partial<Manifest.Options> = {}) {
  return Manifest.capture({ root: dir, ...opts })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("Auto Mode filesystem observer", () => {
  test("observes tracked-like, untracked, ignored, deleted, and Unicode paths", async () => {
    const dir = await root()
    await mkdir(path.join(dir, "src"))
    await writeFile(path.join(dir, ".gitignore"), ".vscode/\n")
    await writeFile(path.join(dir, "src/tracked.ts"), "before")
    await writeFile(path.join(dir, "old untracked.txt"), "remove")
    const before = await capture(dir)

    await writeFile(path.join(dir, "src/tracked.ts"), "after")
    await unlink(path.join(dir, "old untracked.txt"))
    await writeFile(path.join(dir, "новый файл.txt"), "unicode")
    await mkdir(path.join(dir, ".vscode"))
    await writeFile(path.join(dir, ".vscode/tasks.json"), "{}")

    const result = Observe.diff(before, await capture(dir))
    expect(result.diagnostics).toEqual([])
    expect(result.effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "file.write", path: "src/tracked.ts" }),
        expect.objectContaining({ category: "file.delete", path: "old untracked.txt" }),
        expect.objectContaining({ category: "file.write", path: "новый файл.txt" }),
        expect.objectContaining({ category: "file.write", path: ".vscode/tasks.json" }),
      ]),
    )
    const decision = Policy.evaluate({
      phase: "post",
      tool: "write",
      adapter: "supported",
      root: dir,
      effects: result.effects,
      declared: result.effects,
    })
    expect(decision.ruleCodes).toContain("AUTO_PERSISTENCE_PATH")
  })

  test("hashes binary files and observes executable-bit changes", async () => {
    const dir = await root()
    const file = path.join(dir, "tool.bin")
    await writeFile(file, Buffer.from([0, 1, 2, 255]))
    await chmod(file, 0o644)
    const before = await capture(dir)
    await chmod(file, 0o755)
    const after = await capture(dir)

    const left = before.entries.find((entry) => entry.path === "tool.bin")
    const right = after.entries.find((entry) => entry.path === "tool.bin")
    expect(left?.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(left?.fingerprint).toBe(right?.fingerprint)
    expect(left?.executable).toBe(false)
    expect(right?.executable).toBe(true)
    expect(Observe.diff(before, after).effects).toEqual([
      expect.objectContaining({ category: "file.write", path: "tool.bin" }),
    ])
  })

  test("reports type changes as deletion followed by creation", async () => {
    const dir = await root()
    const item = path.join(dir, "item")
    await writeFile(item, "file")
    const before = await capture(dir)
    await unlink(item)
    await symlink("target", item)

    expect(Observe.diff(before, await capture(dir)).effects).toEqual([
      expect.objectContaining({ category: "file.delete", path: "item" }),
      expect.objectContaining({ category: "file.symlink", path: "item", target: "target" }),
    ])
  })

  test("captures internal and external symlink targets without reading either target", async () => {
    const dir = await root()
    const outside = await root()
    await writeFile(path.join(dir, "target"), "inside secret")
    await writeFile(path.join(outside, "secret"), "outside secret")
    const before = await capture(dir)
    await symlink("target", path.join(dir, "inside-link"))
    await symlink(path.join(outside, "secret"), path.join(dir, "outside-link"))

    const after = await capture(dir, { maxFileBytes: 32 })
    const effects = Observe.diff(before, after).effects
    expect(after.diagnostics).toEqual([])
    expect(effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "file.symlink", path: "inside-link", target: "target" }),
        expect.objectContaining({
          category: "file.symlink",
          path: "outside-link",
          target: path.join(outside, "secret"),
        }),
      ]),
    )
    expect(JSON.stringify(effects)).not.toContain("inside secret")
    expect(JSON.stringify(effects)).not.toContain("outside secret")
  })

  test("excludes Git internals and configured Auto Mode storage", async () => {
    const dir = await root()
    await mkdir(path.join(dir, ".git"))
    await mkdir(path.join(dir, ".auto-mode"))
    await writeFile(path.join(dir, ".git/index"), "git")
    await writeFile(path.join(dir, ".auto-mode/state"), "internal")
    await writeFile(path.join(dir, "visible"), "yes")

    const result = await capture(dir, { internal: [".auto-mode"] })
    expect(result.entries.map((entry) => entry.path)).toContain("visible")
    expect(result.entries.some((entry) => entry.path.startsWith(".git"))).toBe(false)
    expect(result.entries.some((entry) => entry.path.startsWith(".auto-mode"))).toBe(false)
  })

  test("fails closed when an entry or byte limit is exceeded", async () => {
    const dir = await root()
    const baseline = await capture(dir)
    await writeFile(path.join(dir, "a"), "1234")
    await writeFile(path.join(dir, "b"), "5678")

    for (const opts of [{ maxEntries: 1 }, { maxFileBytes: 2 }, { maxTotalBytes: 6 }]) {
      const after = await capture(dir, opts)
      const result = Observe.diff(baseline, after)
      expect(after.diagnostics.length).toBeGreaterThan(0)
      expect(result.effects).toEqual([{ category: "unknown" }])
      expect(
        Policy.evaluate({
          phase: "post",
          tool: "write",
          adapter: "supported",
          root: dir,
          effects: result.effects,
          declared: [],
        }).ruleCodes,
      ).toContain("AUTO_UNKNOWN_EFFECT")
    }
  })

  test("turns cancellation into a fail-closed diagnostic", async () => {
    const dir = await root()
    await writeFile(path.join(dir, "file"), "value")
    const ctrl = new AbortController()
    ctrl.abort()

    const result = await capture(dir, { signal: ctrl.signal })
    expect(result.diagnostics).toEqual([{ code: "aborted" }])
    expect(Observe.diff(await capture(await root()), result).effects).toEqual([{ category: "unknown" }])
  })

  test("detects a file changed during capture", async () => {
    const dir = await root()
    const file = path.join(dir, "large.bin")
    await writeFile(file, Buffer.alloc(32 * 1024 * 1024, 1))
    const pending = capture(dir)
    const mutation = new Promise<void>((resolve, reject) => {
      setTimeout(() => writeFile(file, Buffer.alloc(32 * 1024 * 1024, 2)).then(resolve, reject), 0)
    })
    const [result] = await Promise.all([pending, mutation])

    expect(result.diagnostics.some((item) => item.code === "race")).toBe(true)
    expect(Observe.diff(await capture(await root()), result).effects).toEqual([{ category: "unknown" }])
  })
})
