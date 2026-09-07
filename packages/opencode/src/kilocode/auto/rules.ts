import type { ActionEffect, Decision, Phase, RuleCode, Verdict } from "./types"

export type Adapter = "supported" | "unsupported"

export type Input = {
  phase: Phase
  tool: string
  adapter: Adapter
  root: string
  effects: readonly ActionEffect[]
  declared?: readonly ActionEffect[]
  conflict?: boolean
}

type Root = {
  kind: "posix" | "windows"
  prefix: string
  parts: readonly string[]
}

type Effect = ActionEffect & {
  path?: string
  target?: string
  outside: boolean
  incomplete: boolean
}

export type Context = Omit<Input, "effects" | "declared"> & {
  effects: readonly Effect[]
  declared: readonly Effect[]
}

export type Rule = {
  code: RuleCode
  verdict: Exclude<Verdict, "ALLOW">
  match(ctx: Context): boolean
}

export const PERSISTENCE_PATHS = {
  exact: [
    ".vscode/tasks.json",
    ".gitlab-ci.yml",
    "azure-pipelines.yml",
    ".bashrc",
    ".bash_profile",
    ".bash_login",
    ".profile",
    ".zshrc",
    ".zprofile",
    ".zlogin",
    ".zshenv",
    ".config/fish/config.fish",
    ".pre-commit-config.yaml",
    ".pre-commit-config.yml",
    "lefthook.yml",
    "lefthook.yaml",
  ],
  trees: [".github/workflows", ".circleci", ".husky", ".githooks", ".buildkite"],
  names: ["conftest.py"],
  suffixes: [".pth"],
} as const

const mutations = new Set<ActionEffect["category"]>(["file.write", "file.delete", "file.symlink", "persistence.create"])

const dangerous = new Set<ActionEffect["category"]>([
  ...mutations,
  "process.exec",
  "network.connect",
  "package.install",
  "unknown",
])

function segments(input: string) {
  const parts: string[] = []
  for (const part of input.split("/")) {
    if (!part || part === ".") continue
    if (part === "..") {
      if (!parts.pop()) return undefined
      continue
    }
    parts.push(part)
  }
  return parts
}

function parse(input: string): Root | undefined {
  const value = input.replaceAll("\\", "/")
  const drive = /^([A-Za-z]):\/(.*)$/.exec(value)
  if (drive) {
    const parts = segments(drive.at(2) ?? "")
    if (!parts) return undefined
    return { kind: "windows", prefix: `${drive.at(1)?.toLowerCase()}:`, parts }
  }
  if (value.startsWith("//")) {
    const parts = segments(value.slice(2))
    if (!parts || parts.length < 2) return undefined
    return {
      kind: "windows",
      prefix: `//${parts.at(0)?.toLowerCase()}/${parts.at(1)?.toLowerCase()}`,
      parts: parts.slice(2),
    }
  }
  if (!value.startsWith("/")) return undefined
  const parts = segments(value.slice(1))
  if (!parts) return undefined
  return { kind: "posix", prefix: "/", parts }
}

function same(root: Root, path: Root) {
  if (root.kind !== path.kind) return false
  if (root.prefix !== path.prefix) return false
  if (path.parts.length < root.parts.length) return false
  return root.parts.every((part, index) => {
    const value = path.parts.at(index)
    return root.kind === "windows" ? part.toLowerCase() === value?.toLowerCase() : part === value
  })
}

function relative(root: Root, input: string, base: readonly string[] = []) {
  if (input.includes("\0")) return undefined
  const value = input.replaceAll("\\", "/")
  const absolute = parse(value)
  if (absolute) {
    if (!same(root, absolute)) return undefined
    const path = absolute.parts.slice(root.parts.length).join("/")
    return (root.kind === "windows" ? path.toLowerCase() : path) || undefined
  }
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return undefined

  const parts = [...base]
  for (const part of value.split("/")) {
    if (!part || part === ".") continue
    if (part === "..") {
      if (!parts.pop()) return undefined
      continue
    }
    parts.push(part)
  }
  const path = parts.join("/")
  return (root.kind === "windows" ? path.toLowerCase() : path) || undefined
}

function normalize(root: Root, effect: ActionEffect): Effect {
  if (!effect.category.startsWith("file.") && effect.category !== "persistence.create") {
    return { ...effect, outside: false, incomplete: false }
  }

  const path = effect.path ? relative(root, effect.path) : undefined
  const missing = !effect.path || !path
  if (effect.category !== "file.symlink") {
    return { ...effect, path, outside: !!effect.path && !path, incomplete: missing }
  }

  const base = path?.split("/").slice(0, -1) ?? []
  const target = effect.target ? relative(root, effect.target, base) : undefined
  return {
    ...effect,
    path,
    target,
    outside: (!!effect.path && !path) || (!!effect.target && !target),
    incomplete: missing || !effect.target,
  }
}

function key(effect: Effect) {
  return JSON.stringify([effect.category, effect.path ?? null, effect.target ?? null])
}

function persistence(path: string) {
  const value = path.toLowerCase()
  if (PERSISTENCE_PATHS.exact.includes(value as (typeof PERSISTENCE_PATHS.exact)[number])) return true
  if (PERSISTENCE_PATHS.trees.some((tree) => value === tree || value.startsWith(`${tree}/`))) return true
  const name = value.split("/").at(-1) ?? value
  if (PERSISTENCE_PATHS.names.includes(name as (typeof PERSISTENCE_PATHS.names)[number])) return true
  return PERSISTENCE_PATHS.suffixes.some((suffix) => name.endsWith(suffix))
}

function paths(effect: Effect) {
  return [effect.path, effect.category === "file.symlink" ? effect.target : undefined].filter(
    (path): path is string => !!path,
  )
}

export function context(input: Input): Context {
  const root = parse(input.root)
  if (!root) throw new Error("Auto Mode policy root must be absolute")
  return {
    ...input,
    effects: input.effects.map((effect) => normalize(root, effect)),
    declared: (input.declared ?? []).map((effect) => normalize(root, effect)),
  }
}

export const registry: readonly Rule[] = [
  {
    code: "AUTO_UNKNOWN_EFFECT",
    verdict: "ASK",
    match: (ctx) => ctx.effects.some((effect) => effect.category === "unknown" || effect.incomplete),
  },
  {
    code: "AUTO_UNSUPPORTED_TOOL",
    verdict: "DENY",
    match: (ctx) => ctx.adapter === "unsupported",
  },
  {
    code: "AUTO_BACKGROUND_PROCESS",
    verdict: "DENY",
    match: (ctx) => ctx.effects.some((effect) => effect.category === "process.background"),
  },
  {
    code: "AUTO_OUTSIDE_WORKSPACE",
    verdict: "DENY",
    match: (ctx) => ctx.effects.some((effect) => mutations.has(effect.category) && effect.outside),
  },
  {
    code: "AUTO_GIT_INTERNALS",
    verdict: "DENY",
    match: (ctx) =>
      ctx.effects.some(
        (effect) =>
          mutations.has(effect.category) &&
          paths(effect).some((path) => path.split("/").some((part) => part.toLowerCase() === ".git")),
      ),
  },
  {
    code: "AUTO_PERSISTENCE_PATH",
    verdict: "DENY",
    match: (ctx) =>
      ctx.effects.some(
        (effect) =>
          effect.category === "persistence.create" ||
          (mutations.has(effect.category) && paths(effect).some(persistence)),
      ),
  },
  {
    code: "AUTO_DESTRUCTIVE_DELETE",
    verdict: "ASK",
    match: (ctx) =>
      ctx.effects.some(
        (effect) => effect.category === "file.delete",
      ),
  },
  {
    code: "AUTO_LARGE_DESTRUCTIVE_CHANGE",
    verdict: "ASK",
    match: (ctx) =>
      ctx.effects.some((effect) => {
        if (effect.category !== "file.write") return false
        if (effect.bytesBefore == null || effect.bytesAfter == null) return false

        return effect.bytesBefore >= 1024 &&
          effect.bytesAfter < effect.bytesBefore * 0.1
      }),
  },
  {
    code: "AUTO_NETWORK",
    verdict: "ASK",
    match: (ctx) => ctx.effects.some((effect) => effect.category === "network.connect"),
  },
  {
    code: "AUTO_REMOTE_EXEC",
    verdict: "DENY",
    match: (ctx) =>
      ctx.effects.some((effect) => effect.category === "network.connect") &&
      ctx.effects.some((effect) => effect.category === "process.exec"),
  },
  {
    code: "AUTO_PACKAGE_MANAGER_UNSUPPORTED",
    verdict: "DENY",
    match: (ctx) =>
      ctx.effects.some((effect) => effect.category === "package.install" && effect.package?.status === "unsupported"),
  },
  {
    code: "AUTO_PACKAGE_INSTALL",
    verdict: "ASK",
    match: (ctx) =>
      ctx.effects.some((effect) => effect.category === "package.install" && effect.package?.status !== "existing"),
  },
  {
    code: "AUTO_EFFECT_MISMATCH",
    verdict: "DENY",
    match: (ctx) => {
      if (ctx.phase !== "post") return false
      const declared = new Set(ctx.declared.map(key))
      const process = ctx.declared.some((effect) => effect.category === "process.exec")
      return ctx.effects.some(
        (effect) =>
          dangerous.has(effect.category) &&
          !declared.has(key(effect)) &&
          !(process && mutations.has(effect.category) && !effect.outside),
      )
    },
  },
  {
    code: "AUTO_APPLY_CONFLICT",
    verdict: "ASK",
    match: (ctx) => ctx.conflict === true,
  },
]

export function decide(input: Input): Decision {
  const ctx = context(input)
  const matched = registry.filter((rule) => rule.match(ctx))
  const verdict = matched.reduce<Verdict>((result, rule) => {
    if (result === "DENY" || rule.verdict === "DENY") return "DENY"
    return "ASK"
  }, "ALLOW")
  const ruleCodes = matched.map((rule) => rule.code)
  const summary =
    verdict === "ALLOW"
      ? "Policy allows the evaluated effects."
      : verdict === "DENY"
        ? "Policy denied the evaluated effects."
        : "Policy requires review of the evaluated effects."
  return { phase: input.phase, verdict, ruleCodes, summary } as Decision
}
