import { Hash } from "@opencode-ai/core/util/hash"
import path from "node:path"
import type { ActionEffect } from "./types"
import * as Package from "./package"

type Token = { kind: "word" | "operator"; text: string }

type Scan = {
  tokens: readonly Token[]
  dynamic: boolean
}

export type Result = {
  effects: readonly ActionEffect[]
  supported: boolean
}

const network = new Set(["curl", "wget", "nc", "ncat", "netcat", "ssh", "scp", "sftp", "ftp", "telnet", "rsync"])
const background = new Set(["bg", "daemon", "daemonize", "disown", "nohup", "setsid"])
// kilocode_change start: чтение файлов из shell объявляется как file.read, чтобы правило секретов видело
// "cat .env" так же, как инструмент read. Для команд с шаблоном первым аргументом (grep, awk, sed) он пропускается.
const devices = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/zero"])
const readers = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "awk",
  "sed",
  "cut",
  "sort",
  "uniq",
  "wc",
  "strings",
  "base64",
  "xxd",
  "od",
  "hexdump",
  "diff",
  "stat",
  "file",
])
const patterned = new Set(["grep", "egrep", "fgrep", "rg", "awk", "sed"])

function reads(cmd: string, args: readonly string[], cwd: string): ActionEffect[] {
  if (!readers.has(cmd)) return []
  const files = values(args).filter((value) => !/^\d+$/.test(value))
  return files.slice(patterned.has(cmd) ? 1 : 0).map((value) => ({ category: "file.read", path: target(value, cwd) }))
}
// kilocode_change end
const opaque = new Set([
  "command",
  "env",
  "exec",
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "for",
  "while",
  "until",
  "case",
  "xargs",
])
const interpreters = new Map([
  ["bash", new Set(["-c"])],
  ["sh", new Set(["-c"])],
  ["zsh", new Set(["-c"])],
  ["node", new Set(["-e", "--eval"])],
  ["bun", new Set(["-e", "--eval"])],
  ["python", new Set(["-c"])],
  ["python3", new Set(["-c"])],
  ["ruby", new Set(["-e"])],
  ["perl", new Set(["-e"])],
])
const git = new Set([
  "add",
  "am",
  "apply",
  "bisect",
  "branch",
  "checkout",
  "cherry-pick",
  "clean",
  "clone",
  "commit",
  "fetch",
  "gc",
  "init",
  "merge",
  "mv",
  "pull",
  "push",
  "rebase",
  "reset",
  "restore",
  "revert",
  "rm",
  "stash",
  "switch",
  "tag",
])

function tokenize(source: string): Scan | undefined {
  const tokens: Token[] = []
  let word = ""
  let quote: "'" | '"' | undefined
  let dynamic = false
  const push = () => {
    if (!word) return
    tokens.push({ kind: "word", text: word })
    word = ""
  }

  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (quote) {
      if (char === quote) {
        quote = undefined
        continue
      }
      if (quote === '"' && (char === "$" || char === "`")) dynamic = true
      if (char === "\\" && quote === '"') {
        const next = source.at(++i)
        if (next == null) return
        word += next
        continue
      }
      word += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === "\\") {
      const next = source.at(++i)
      if (next == null) return
      word += next
      continue
    }
    if (char === "$" || char === "`" || char === "(" || char === ")" || char === "{" || char === "}") {
      dynamic = true
    }
    if (/\s/.test(char)) {
      if (char === "\n" || char === "\r") dynamic = true
      push()
      continue
    }
    if (!"&|;<>".includes(char)) {
      word += char
      continue
    }
    push()
    const pair = char + (source.at(i + 1) ?? "")
    // kilocode_change: ">&" и "&>" — операторы перенаправления, а не фоновый запуск ("2>&1", "&>log").
    if (["&&", "||", ">>", "<<", ">&", "&>"].includes(pair)) {
      tokens.push({ kind: "operator", text: pair })
      i++
      continue
    }
    tokens.push({ kind: "operator", text: char })
  }
  if (quote) return
  push()
  return { tokens, dynamic }
}

function base(value: string) {
  return path.basename(value).toLowerCase()
}

function target(value: string, cwd: string) {
  return path.resolve(cwd, value)
}

function values(words: readonly string[]) {
  return words.filter((word) => !word.startsWith("-"))
}

function mutation(cmd: string, args: readonly string[], cwd: string): ActionEffect[] {
  if (["mkdir", "touch", "rm", "rmdir", "unlink"].includes(cmd)) {
    return values(args).map((value) => ({
      category: cmd === "rm" || cmd === "rmdir" || cmd === "unlink" ? "file.delete" : "file.write",
      path: target(value, cwd),
    }))
  }
  if (cmd === "cp" || cmd === "mv" || cmd === "install") {
    const value = values(args).at(-1)
    if (!value) return [{ category: "unknown" }]
    return [{ category: "file.write", path: target(value, cwd) }]
  }
  if (cmd === "tee") {
    return values(args).map((value) => ({ category: "file.write", path: target(value, cwd) }))
  }
  if ((cmd === "chmod" || cmd === "chown") && args.length > 1) {
    return values(args.slice(1)).map((value) => ({ category: "file.write", path: target(value, cwd) }))
  }
  if (cmd === "sed" && args.some((arg) => arg === "-i" || arg.startsWith("-i"))) {
    const value = values(args).at(-1)
    return value ? [{ category: "file.write", path: target(value, cwd) }] : [{ category: "unknown" }]
  }
  return []
}

function unique(effects: readonly ActionEffect[]) {
  const seen = new Set<string>()
  return effects.filter((effect) => {
    const key = JSON.stringify([
      effect.category,
      effect.path ?? null,
      effect.target ?? null,
      effect.fingerprint ?? null,
      effect.package ?? null,
    ])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function classify(args: unknown, root: string): Result {
  if (typeof args !== "object" || args == null || Array.isArray(args)) {
    return { supported: true, effects: [{ category: "unknown" }] }
  }
  const input = args as Record<string, unknown>
  const command = typeof input.command === "string" ? input.command.trim() : ""
  const workdir = typeof input.workdir === "string" && input.workdir ? input.workdir : root
  const cwd = path.resolve(root, workdir)
  const rel = path.relative(root, cwd)
  if (!command || rel.startsWith("..") || path.isAbsolute(rel) || process.platform === "win32") {
    return { supported: false, effects: [{ category: "unknown" }] }
  }

  const scan = tokenize(command)
  if (!scan) return { supported: true, effects: [{ category: "unknown" }] }
  const effects: ActionEffect[] = [{ category: "process.exec", fingerprint: Hash.sha256(command) }]
  if (scan.dynamic) effects.push({ category: "unknown" })

  const chunks: string[][] = [[]]
  for (let i = 0; i < scan.tokens.length; i++) {
    const token = scan.tokens.at(i)
    if (!token) continue
    if (token.kind === "word") {
      chunks.at(-1)?.push(token.text)
      continue
    }
    if (token.text === "&") effects.push({ category: "process.background" })
    if (token.text === "<<" || token.text === "<") {
      effects.push({ category: "unknown" })
    }
    if (token.text === ">" || token.text === ">>" || token.text === ">&" || token.text === "&>") {
      const next = scan.tokens.at(i + 1)
      if (next?.kind !== "word") effects.push({ category: "unknown" })
      if (next?.kind === "word") {
        // kilocode_change start: дублирование дескриптора ("2>&1", ">&2") и псевдоустройства ("2>/dev/null")
        // не являются записью файла. Раньше "/dev/null" считался записью вне workspace (DENY), а "&" из
        // "2>&1" — фоновым процессом (DENY): обе идиомы блокировали легитимные команды.
        const descriptor = token.text === ">&" && /^\d+$/.test(next.text)
        if (!descriptor && !devices.has(next.text)) {
          effects.push({ category: "file.write", path: target(next.text, cwd) })
        }
        // kilocode_change end
        i++
      }
    }
    if (["&&", "||", "|", ";", "&"].includes(token.text)) chunks.push([])
  }

  for (const words of chunks) {
    const offset = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=[^\0]*$/.test(word))
    if (offset < 0) {
      effects.push({ category: "unknown" })
      continue
    }
    const cmd = base(words.at(offset) ?? "")
    const rest = words.slice(offset + 1)
    if (!cmd) {
      effects.push({ category: "unknown" })
      continue
    }
    if (network.has(cmd) || (cmd === "git" && ["clone", "fetch", "pull", "push"].includes(rest.at(0) ?? ""))) {
      effects.push({ category: "network.connect" })
    }
    if (background.has(cmd)) effects.push({ category: "process.background" })
    if (rest.some((arg) => ["--background", "--daemon", "--detach", "--detached"].includes(arg))) {
      effects.push({ category: "process.background" })
    }
    if (
      opaque.has(cmd) ||
      cmd === "eval" ||
      cmd === "source" ||
      cmd === "." ||
      interpreters.get(cmd)?.has(rest.at(0) ?? "")
    ) {
      effects.push({ category: "unknown" })
    }
    if (cmd === "git" && git.has(rest.at(0) ?? "")) {
      effects.push({ category: "file.write", path: path.join(root, ".git") })
    }
    const packages =
      cmd === "corepack" && rest.at(0) ? Package.classify(base(rest.at(0) ?? ""), rest.slice(1), cwd) : []
    effects.push(...mutation(cmd, rest, cwd), ...reads(cmd, rest, cwd), ...Package.classify(cmd, rest, cwd), ...packages) // kilocode_change
  }

  return { supported: true, effects: unique(effects) }
}

export function rewrite<A>(args: A, root: string, shadow: string): A {
  if (typeof args !== "object" || args == null || Array.isArray(args)) return args
  const input = args as Record<string, unknown>
  if (typeof input.workdir !== "string" || !input.workdir) return { ...input, workdir: shadow } as A
  const cwd = path.resolve(root, input.workdir)
  const rel = path.relative(root, cwd)
  if (rel.startsWith("..") || path.isAbsolute(rel)) return args
  return { ...input, workdir: path.join(shadow, rel) } as A
}
