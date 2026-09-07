import path from "node:path"
import { Schema } from "effect"
import type { ActionEffect } from "./types"

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))
const Name = Text.check(Schema.isPattern(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/))

export const Metadata = Schema.Struct({
  status: Schema.Literals(["known", "new", "typo", "unknown"]),
  canonical: Schema.optional(Name),
}).annotate({ identifier: "AutoPackageMetadata" })
export type Metadata = Schema.Schema.Type<typeof Metadata>

export type Query = {
  manager: "bun" | "npm" | "pnpm" | "yarn"
  name: string
  signal: AbortSignal
}

export type Checker = (query: Query) => Promise<Metadata>

type Manager = Query["manager"]
type Operation = "install" | "add" | "update" | "remove"

const managers = new Set<Manager>(["bun", "npm", "pnpm", "yarn"])
const unsupported = new Set(["cargo", "composer", "gem", "pip", "pip3"])
const locks: Record<Manager, readonly string[]> = {
  bun: ["bun.lock", "bun.lockb"],
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
}
const values = new Set(["--cache", "--cwd", "--global-dir", "--global-folder", "--prefix", "--registry", "--store-dir"])

function operation(value: string): Operation | undefined {
  const input = value.toLowerCase()
  if (input === "add") return "add"
  if (["install", "i", "ci"].includes(input)) return "install"
  if (["update", "upgrade", "up"].includes(input)) return "update"
  if (["remove", "uninstall", "rm"].includes(input)) return "remove"
}

function args(input: readonly string[], offset: number) {
  const result: string[] = []
  for (let i = offset; i < input.length; i++) {
    const value = input.at(i)
    if (!value) continue
    if (values.has(value)) {
      i++
      continue
    }
    if (value.startsWith("-")) continue
    result.push(value)
  }
  return result
}

function direct(input: string) {
  if (/^(?:https?|git(?:\+[^:]+)?|github|gitlab|bitbucket):/i.test(input)) return "url" as const
  if (/^(?:file|link|workspace):/i.test(input)) return "path" as const
  if (/^(?:\.{0,2}\/|~\/|\/|[A-Za-z]:[\\/])/.test(input)) return "path" as const
}

function spec(input: string) {
  const risk = direct(input)
  if (risk) return { spec: risk, risk: true }
  if (input.includes("@npm:")) return { spec: "alias", risk: true }

  const split = input.startsWith("@") ? input.indexOf("@", input.indexOf("/") + 1) : input.lastIndexOf("@")
  const name = split > 0 ? input.slice(0, split) : input
  const value = split > 0 ? input.slice(split + 1) : undefined
  const valid = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)
  const safe = value && /^[A-Za-z0-9*^~<>=|+._-]{1,128}$/.test(value) ? value : value ? "invalid" : undefined
  return { name: name.toLowerCase(), spec: safe, risk: !valid || safe === "invalid" || /[^\x20-\x7e]/.test(input) }
}

export function classify(cmd: string, input: readonly string[], cwd: string): ActionEffect[] {
  const manager = cmd.toLowerCase()
  if (!managers.has(manager as Manager) && !unsupported.has(manager)) return []
  const implicit = manager === "yarn" && input.every((value) => value.startsWith("-"))
  const index = implicit ? -1 : input.findIndex((value) => operation(value) != null)
  if (!implicit && index < 0) return []
  const op = implicit ? "install" : operation(input.at(index) ?? "")
  if (!op) return []
  const supported = managers.has(manager as Manager)
  const packages = args(input, implicit ? input.length : index + 1)
  const items = packages.length ? packages : [undefined]

  return items.map((item): ActionEffect => {
    const parsed = item ? spec(item) : { name: undefined, spec: undefined, risk: false }
    return {
      category: "package.install",
      path: cwd,
      package: {
        manager: supported ? (manager as Manager) : "unsupported",
        operation: op,
        name: parsed.name,
        spec: parsed.spec,
        status: supported ? (parsed.risk ? "suspicious" : "unknown") : "unsupported",
        manifests: [],
        locks: [],
      },
    }
  })
}

function inside(root: string, input: string) {
  const rel = path.relative(root, input)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

async function project(root: string, cwd: string, manager: Manager) {
  const base = path.resolve(cwd)
  const start = inside(root, base) ? base : root
  const dirs: string[] = []
  for (let dir = start; inside(root, dir); dir = path.dirname(dir)) {
    dirs.push(dir)
    if (dir === root) break
  }
  const dir =
    (
      await Promise.all(
        dirs.map(async (dir) => ((await Bun.file(path.join(dir, "package.json")).exists()) ? dir : undefined)),
      )
    ).find((dir) => dir != null) ?? start
  const manifest = path.join(dir, "package.json")
  const names = locks[manager]
  const found = await Promise.all(
    names.map(async (name) => ((await Bun.file(path.join(dir, name)).exists()) ? name : undefined)),
  )
  const current = found.filter((name): name is string => name != null)
  return {
    dir,
    manifest,
    manifests: [path.relative(root, manifest) || "package.json"],
    locks: (current.length ? current : [names.at(0) ?? "package-lock.json"]).map((name) =>
      path.relative(root, path.join(dir, name)),
    ),
  }
}

async function dependencies(file: string) {
  try {
    if (!(await Bun.file(file).exists())) return { names: new Set<string>(), valid: false }
    const data = await Bun.file(file).json()
    if (typeof data !== "object" || data == null || Array.isArray(data))
      return { names: new Set<string>(), valid: false }
    const input = data as Record<string, unknown>
    const groups = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
    const names = groups.flatMap((key) => {
      const value = input[key]
      return typeof value === "object" && value != null && !Array.isArray(value) ? Object.keys(value) : []
    })
    return { names: new Set(names.map((name) => name.toLowerCase())), valid: true }
  } catch {
    return { names: new Set<string>(), valid: false }
  }
}

async function metadata(
  checker: Checker | undefined,
  query: Omit<Query, "signal">,
  timeout: number,
  signal?: AbortSignal,
) {
  if (!checker) return Metadata.make({ status: "unknown" })
  const controller = new AbortController()
  const expired = Promise.withResolvers<never>()
  const abort = () => {
    controller.abort(signal?.reason)
    expired.reject(signal?.reason ?? new Error("Package metadata cancelled"))
  }
  if (signal?.aborted) abort()
  signal?.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(() => {
    controller.abort(new Error("Package metadata timeout"))
    expired.reject(controller.signal.reason)
  }, timeout)
  try {
    const value = await Promise.race([checker({ ...query, signal: controller.signal }), expired.promise])
    return Schema.decodeUnknownSync(Metadata)(value)
  } catch {
    return Metadata.make({ status: "unknown" })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
  }
}

export async function assess(
  effects: readonly ActionEffect[],
  opts: { root: string; checker?: Checker; timeout?: number; signal?: AbortSignal },
) {
  return Promise.all(
    effects.map(async (effect): Promise<ActionEffect> => {
      const info = effect.package
      if (effect.category !== "package.install" || !info || info.manager === "unsupported") return effect
      const pkg = await project(opts.root, effect.path ?? opts.root, info.manager)
      const manifest = await dependencies(pkg.manifest)
      const locked = await Promise.all(pkg.locks.map((file) => Bun.file(path.join(opts.root, file)).exists()))
      const existing = info.name ? manifest.names.has(info.name) : manifest.valid && locked.some(Boolean)
      const lookup =
        !existing && info.name && info.status !== "suspicious"
          ? await metadata(
              opts.checker,
              { manager: info.manager, name: info.name },
              Math.max(1, Math.min(opts.timeout ?? 1_000, 5_000)),
              opts.signal,
            )
          : undefined
      const status =
        info.status === "suspicious" ||
        lookup?.status === "typo" ||
        (lookup?.canonical != null && lookup.canonical !== info.name)
          ? "suspicious"
          : existing
            ? "existing"
            : lookup?.status === "known" || lookup?.status === "new"
              ? "new"
              : "unknown"
      return {
        ...effect,
        package: {
          ...info,
          status,
          canonical: lookup?.canonical,
          manifests: pkg.manifests,
          locks: pkg.locks,
        },
      }
    }),
  )
}
