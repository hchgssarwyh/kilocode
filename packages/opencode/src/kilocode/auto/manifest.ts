import { createHash } from "node:crypto"
import { constants, type BigIntStats } from "node:fs"
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises"
import path from "node:path"

export namespace Manifest {
  export type Kind = "directory" | "file" | "symlink"

  export type Entry = {
    path: string
    kind: Kind
    size: number
    executable: boolean
    fingerprint?: string
    target?: string
  }

  export type Diagnostic = {
    code: "aborted" | "entries" | "read" | "race" | "size" | "unsupported"
    path?: string
  }

  export type Info = {
    root: string
    entries: readonly Entry[]
    diagnostics: readonly Diagnostic[]
  }

  export type Options = {
    root: string
    signal?: AbortSignal
    internal?: readonly string[]
    maxEntries?: number
    maxFileBytes?: number
    maxTotalBytes?: number
  }

  export const LIMITS = {
    entries: 100_000,
    fileBytes: 64 * 1024 * 1024,
    totalBytes: 512 * 1024 * 1024,
    pathLength: 4_096,
  } as const

  type Budget = {
    entries: number
    bytes: number
    maxEntries: number
    maxFileBytes: number
    maxTotalBytes: number
  }

  function fingerprint(bytes: Uint8Array) {
    return createHash("sha256").update(bytes).digest("hex")
  }

  function same(left: BigIntStats, right: BigIntStats) {
    return (
      left.dev === right.dev &&
      left.ino === right.ino &&
      left.mode === right.mode &&
      left.size === right.size &&
      left.mtimeNs === right.mtimeNs &&
      left.ctimeNs === right.ctimeNs
    )
  }

  function relative(input: string) {
    const value = input.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "")
    if (!value || value.startsWith("/") || value.includes("\0")) return
    const parts = value.split("/")
    if (parts.some((part) => !part || part === "." || part === "..")) return
    return parts.join("/")
  }

  function excluded(rel: string, internal: ReadonlySet<string>) {
    const parts = rel.split("/")
    if (parts.some((part) => part === ".git")) return true
    return [...internal].some((item) => rel === item || rel.startsWith(`${item}/`))
  }

  function diagnostic(err: unknown, rel?: string): Diagnostic {
    if (err instanceof DOMException && err.name === "AbortError") return { code: "aborted", path: rel }
    return { code: "read", path: rel }
  }

  async function file(full: string, rel: string, info: BigIntStats, opts: Options, budget: Budget): Promise<Entry> {
    if (info.size > BigInt(budget.maxFileBytes) || budget.bytes + Number(info.size) > budget.maxTotalBytes) {
      throw { diagnostic: { code: "size", path: rel } satisfies Diagnostic }
    }
    opts.signal?.throwIfAborted()
    const flags = process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW
    const handle = await open(full, flags)
    try {
      const opened = await handle.stat({ bigint: true })
      if (!opened.isFile() || !same(info, opened)) {
        throw { diagnostic: { code: "race", path: rel } satisfies Diagnostic }
      }
      const hash = createHash("sha256")
      const chunk = Buffer.allocUnsafe(64 * 1024)
      let offset = 0
      while (offset < Number(opened.size)) {
        opts.signal?.throwIfAborted()
        const result = await handle.read(chunk, 0, Math.min(chunk.length, Number(opened.size) - offset), offset)
        if (!result.bytesRead) break
        hash.update(chunk.subarray(0, result.bytesRead))
        offset += result.bytesRead
      }
      const after = await handle.stat({ bigint: true })
      const current = await lstat(full, { bigint: true })
      if (offset !== Number(opened.size) || !same(opened, after) || !same(after, current)) {
        throw { diagnostic: { code: "race", path: rel } satisfies Diagnostic }
      }
      budget.bytes += offset
      return {
        path: rel,
        kind: "file",
        size: offset,
        executable: (Number(opened.mode) & 0o111) !== 0,
        fingerprint: hash.digest("hex"),
      }
    } finally {
      await handle.close()
    }
  }

  async function entry(full: string, rel: string, opts: Options, budget: Budget): Promise<Entry> {
    opts.signal?.throwIfAborted()
    const before = await lstat(full, { bigint: true })
    if (before.isFile()) return file(full, rel, before, opts, budget)
    if (before.isSymbolicLink()) {
      const target = await readlink(full)
      if (target.length > LIMITS.pathLength) {
        throw { diagnostic: { code: "size", path: rel } satisfies Diagnostic }
      }
      const after = await lstat(full, { bigint: true })
      if (!same(before, after)) throw { diagnostic: { code: "race", path: rel } satisfies Diagnostic }
      return {
        path: rel,
        kind: "symlink",
        size: Buffer.byteLength(target),
        executable: false,
        target,
        fingerprint: fingerprint(Buffer.from(target)),
      }
    }
    if (before.isDirectory()) {
      return { path: rel, kind: "directory", size: 0, executable: (Number(before.mode) & 0o111) !== 0 }
    }
    throw { diagnostic: { code: "unsupported", path: rel } satisfies Diagnostic }
  }

  function failure(err: unknown, rel?: string) {
    if (
      typeof err === "object" &&
      err != null &&
      "diagnostic" in err &&
      typeof err.diagnostic === "object" &&
      err.diagnostic != null &&
      "code" in err.diagnostic
    ) {
      return err.diagnostic as Diagnostic
    }
    return diagnostic(err, rel)
  }

  export async function capture(opts: Options): Promise<Info> {
    const entries: Entry[] = []
    const diagnostics: Diagnostic[] = []
    const budget: Budget = {
      entries: 0,
      bytes: 0,
      maxEntries: opts.maxEntries ?? LIMITS.entries,
      maxFileBytes: opts.maxFileBytes ?? LIMITS.fileBytes,
      maxTotalBytes: opts.maxTotalBytes ?? LIMITS.totalBytes,
    }
    const root = await realpath(opts.root).catch(() => path.resolve(opts.root))
    const internal = new Set((opts.internal ?? []).map(relative).filter((item): item is string => !!item))

    const visit = async (dir: string, prefix = ""): Promise<void> => {
      opts.signal?.throwIfAborted()
      const before = await lstat(dir, { bigint: true })
      if (!before.isDirectory()) throw { diagnostic: { code: "race", path: prefix || undefined } satisfies Diagnostic }
      const names = await readdir(dir)
      names.sort((a, b) => Buffer.from(a).compare(Buffer.from(b)))
      for (const name of names) {
        opts.signal?.throwIfAborted()
        const rel = prefix ? `${prefix}/${name}` : name
        if (excluded(rel, internal)) continue
        if (rel.length > LIMITS.pathLength) {
          diagnostics.push({ code: "size", path: prefix || undefined })
          continue
        }
        if (++budget.entries > budget.maxEntries) {
          diagnostics.push({ code: "entries", path: rel })
          return
        }
        const full = path.join(dir, name)
        const item = await entry(full, rel, opts, budget).catch((err) => {
          diagnostics.push(failure(err, rel))
          return undefined
        })
        if (!item) continue
        entries.push(item)
        if (item.kind === "directory") await visit(full, rel)
        if (diagnostics.some((item) => item.code === "entries")) return
      }
      const after = await lstat(dir, { bigint: true })
      if (!same(before, after)) {
        throw { diagnostic: { code: "race", path: prefix || undefined } satisfies Diagnostic }
      }
    }

    await visit(root).catch((err) => diagnostics.push(failure(err)))
    return { root, entries, diagnostics }
  }
}
