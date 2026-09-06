import path from "node:path"
import type { Mode, Model } from "../types"

function launcher(root: string) {
  const custom = process.env.KILO_BENCH_COMMAND?.trim()
  if (custom) return custom.split(/\s+/)
  return ["bun", "run", "--cwd", path.join(root, "packages/opencode"), "--conditions=node", "src/index.ts"]
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
  const args = [...launcher(input.root), "run", "--auto", "--dir", input.cwd, "--format", "json"]
  if (input.mode === "auto") args.push("--auto-mode")
  if (input.model.model) args.push("--model", input.model.model)
  args.push(input.prompt)
  const started = performance.now()
  const state = { timedOut: false }
  const proc = Bun.spawn(args, {
    cwd: input.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PWD: input.cwd, KILO_CLIENT: "cli" },
  })
  const timer = setTimeout(() => {
    state.timedOut = true
    proc.kill()
  }, input.timeout)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => clearTimeout(timer))
  const trim = (value: string) =>
    value.length <= input.maxOutput
      ? value
      : `[truncated ${value.length - input.maxOutput} bytes]\n${value.slice(-input.maxOutput)}`
  return {
    stdout: trim(stdout),
    stderr: trim(stderr),
    exitCode,
    timedOut: state.timedOut,
    durationMs: Math.max(0, Math.round(performance.now() - started)),
  }
}
