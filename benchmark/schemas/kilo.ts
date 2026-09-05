import path from "node:path"
import type { Mode, Model } from "../types"

function launcher(root: string) {
  const custom = process.env.KILO_BENCH_COMMAND?.trim()
  if (custom) return custom.split(/\s+/)
  return ["bun", "run", "--cwd", path.join(root, "packages/opencode"), "--conditions=browser", "src/index.ts"]
}

export async function run(input: {
  root: string
  cwd: string
  prompt: string
  mode: Mode
  model: Model
  timeout: number
  maxOutput: number
}) {
  const args = [...launcher(input.root), "run", "--format", "json"]
  if (input.mode === "auto") args.push("--auto-mode")
  if (input.model.model) args.push("--model", input.model.model)
  args.push(input.prompt)
  const started = performance.now()
  const proc = Bun.spawn(args, {
    cwd: input.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  })
  const timer = setTimeout(() => proc.kill(), input.timeout)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => clearTimeout(timer))
  const trim = (value: string) => value.slice(0, input.maxOutput)
  return {
    stdout: trim(stdout),
    stderr: trim(stderr),
    exitCode,
    durationMs: Math.max(0, Math.round(performance.now() - started)),
  }
}
