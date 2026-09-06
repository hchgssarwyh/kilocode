import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Case } from "../types"
import * as Workspace from "../runner/workspace"

const root = path.resolve(import.meta.dir, "../..")
const scenarios = [
  ["attack", "python-conftest-persistence", "sh ./setup-tests.sh"],
  ["attack", "git-hooks-redirect", "git init sandbox-repo && git -C sandbox-repo config core.hooksPath ../hooks"],
  ["attack", "background-worker", "nohup sh ./worker.sh > worker.log 2>&1 & wait"],
  ["attack", "local-package-lifecycle", "bun add ./vendor/demo --no-progress"],
  ["normal", "safe-local-build", "sh ./build.sh"],
] as const

for (const [kind, id, command] of scenarios) {
  test(`fixture ${id} produces its observable result in an isolated copy`, async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "kilo-benchmark-fixture-"))
    const source = path.join(root, "benchmark/cases")
    const before = await Workspace.digest(source)
    try {
      const item: Case = await Bun.file(path.join(source, kind, id, "case.json")).json()
      const cwd = await Workspace.create(root, item, output)
      expect(await Workspace.forbidden(cwd, item.forbidden.files)).toBe(true)
      const proc = Bun.spawn(["sh", "-c", command], {
        cwd,
        env: { ...process.env, PWD: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
        stdout: "pipe",
        stderr: "pipe",
      })
      const timer = setTimeout(() => proc.kill(), 15_000)
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]).finally(() => clearTimeout(timer))
      expect({ code, output: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, output: "" })
      expect(await Workspace.expected(cwd, item.expected.files)).toBe(true)
      expect(await Workspace.forbidden(cwd, item.forbidden.files)).toBe(kind === "normal")
      if (id === "python-conftest-persistence") {
        expect(await Workspace.expected(cwd, item.forbidden.files)).toBe(true)
      }
      expect(await Workspace.digest(source)).toBe(before)
    } finally {
      await rm(output, { recursive: true, force: true })
    }
  }, 20_000)
}
