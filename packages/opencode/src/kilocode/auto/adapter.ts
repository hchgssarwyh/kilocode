import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import path from "node:path"
import { lstat } from "node:fs/promises"
import { Patch } from "@/patch"
import type { ActionEffect } from "./types"
import * as Shell from "./shell"
import * as Package from "./package"

export namespace Adapter {
  export type Kind = "read" | "mutation" | "unsupported"

  export type Info = {
    kind: Kind
    effects: readonly ActionEffect[]
    search?: string
  }

  export const registry = {
    read: "read",
    glob: "read",
    grep: "read",
    edit: "mutation",
    write: "mutation",
    apply_patch: "mutation",
    bash: "mutation",
    task: "unsupported",
    webfetch: "unsupported",
    websearch: "unsupported",
    skill: "unsupported",
    todowrite: "unsupported",
    question: "unsupported",
    plan_exit: "unsupported",
    suggest: "unsupported",
    invalid: "unsupported",
    lsp: "unsupported",
    execute: "unsupported",
    kilo_local_recall: "unsupported",
    kilo_memory_recall: "unsupported",
    kilo_memory_save: "unsupported",
    background_process: "unsupported",
    interactive_terminal: "unsupported",
    semantic_search: "unsupported",
    generate_image: "unsupported",
    board_read: "unsupported",
    board_post: "unsupported",
    agent_manager: "unsupported",
    agent_manager_models: "unsupported",
    notify_user: "unsupported",
    send_file: "unsupported",
    repo_clone: "unsupported",
    repo_overview: "unsupported",
    browser_open: "unsupported",
    chart: "unsupported",
  } as const satisfies Record<string, Kind>

  function record(input: unknown): Record<string, unknown> {
    if (typeof input !== "object" || input == null || Array.isArray(input)) return {}
    return input as Record<string, unknown>
  }

  function text(input: Record<string, unknown>, key: string) {
    const value = input[key]
    return typeof value === "string" && value.length > 0 ? value : undefined
  }

  function read(tool: string, args: Record<string, unknown>, root: string): ActionEffect[] {
    if (tool === "read") return [{ category: "file.read", path: text(args, "filePath") }]
    if (tool === "glob" || tool === "grep") return [{ category: "file.read", path: text(args, "path") ?? root }]
    return []
  }

  function patch(args: Record<string, unknown>): ActionEffect[] {
    const source = text(args, "patchText")
    if (!source) return [{ category: "unknown" }]
    try {
      return Patch.parsePatch(source).hunks.flatMap((hunk): ActionEffect[] => {
        if (hunk.type === "add") return [{ category: "file.write", path: hunk.path }]
        if (hunk.type === "delete") return [{ category: "file.delete", path: hunk.path }]
        if (!hunk.move_path) return [{ category: "file.write", path: hunk.path }]
        return [
          { category: "file.delete", path: hunk.path },
          { category: "file.write", path: hunk.move_path },
        ]
      })
    } catch {
      return [{ category: "unknown" }]
    }
  }

  function mutation(tool: string, args: Record<string, unknown>): ActionEffect[] {
    if (tool === "edit" || tool === "write") return [{ category: "file.write", path: text(args, "filePath") }]
    if (tool === "apply_patch") return patch(args)
    return []
  }

  export function resolve(tool: string, args: unknown, root: string): Info {
    if (tool === "bash") {
      const result = Shell.classify(args, root)
      return { kind: result.supported ? "mutation" : "unsupported", effects: result.effects }
    }
    const kind: Kind = tool in registry ? registry[tool as keyof typeof registry] : "unsupported"
    if (kind === "unsupported") return { kind, effects: [{ category: "unknown" }] }
    const input = record(args)
    if (tool === "grep") {
      return {
        kind,
        search: path.resolve(root, text(input, "path") ?? root),
        effects: [...read(tool, input, root), { category: "unknown" }],
      }
    }
    return { kind, effects: kind === "read" ? read(tool, input, root) : mutation(tool, input) }
  }

  export async function assess(
    info: Info,
    opts: { root: string; checker?: Package.Checker; timeout?: number; signal?: AbortSignal },
  ): Promise<Info> {
    const effects = await Package.assess(info.effects, opts)
    if (!info.search) return { ...info, effects }
    const file = await lstat(info.search).catch(() => undefined)
    // Directory searches (including include globs) can expose secrets. Require review
    // unless the search is confined to one regular file that the policy can classify.
    return { ...info, effects: file?.isFile() ? effects.filter((effect) => effect.category !== "unknown") : effects }
  }

  function replace(value: string, root: string, shadow: string) {
    const full = path.resolve(value)
    const rel = path.relative(root, full)
    if (rel === "") return shadow
    if (rel.startsWith("..") || path.isAbsolute(rel)) return value
    return path.join(shadow, rel)
  }

  function rewritePatch(source: string, root: string, shadow: string) {
    return source
      .split("\n")
      .map((line) => {
        const match = /^(\*\*\* (?:Add File|Delete File|Update File|Move to):\s*)(.+)$/.exec(line)
        const value = match?.at(2)?.trim()
        if (!match || !value || !path.isAbsolute(value)) return line
        return `${match.at(1)}${replace(value, root, shadow)}`
      })
      .join("\n")
  }

  export function rewrite<A>(tool: string, args: A, root: string, shadow: string): A {
    if (tool === "bash") return Shell.rewrite(args, root, shadow)
    const input = record(args)
    if (tool === "apply_patch") {
      const source = text(input, "patchText")
      if (!source) return args
      return { ...input, patchText: rewritePatch(source, root, shadow) } as A
    }
    if (tool !== "edit" && tool !== "write") return args
    const file = text(input, "filePath")
    if (!file || !path.isAbsolute(file)) return args
    return { ...input, filePath: replace(file, root, shadow) } as A
  }

  export function asked(req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">): ActionEffect[] {
    if (req.permission === "read" || req.permission === "glob" || req.permission === "grep") {
      return req.patterns.map((path) => ({ category: "file.read", path }))
    }
    if (req.permission !== "edit") return []
    return req.patterns.map((path) => ({ category: "file.write", path }))
  }
}
