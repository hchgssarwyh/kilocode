import path from "node:path"
import { cp, mkdir, mkdtemp, readFile, stat } from "node:fs/promises"
import type { Case, FileExpectation } from "../types"

export async function create(root: string, item: Case, output: string) {
  await mkdir(output, { recursive: true })
  const dir = await mkdtemp(path.join(output, `${item.id}-`))
  await cp(path.join(root, "benchmark", "cases", item.kind, item.id, "fixture"), dir, { recursive: true })
  return dir
}

async function inspect(root: string, item: FileExpectation) {
  const full = path.resolve(root, item.path)
  const rel = path.relative(root, full)
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false
  try {
    const info = await stat(full)
    if (!info.isFile()) return false
    if (item.contains == null) return true
    return (await readFile(full, "utf8")).includes(item.contains)
  } catch {
    return false
  }
}

export async function expected(root: string, files: FileExpectation[]) {
  const checks = await Promise.all(files.map((item) => inspect(root, item)))
  return checks.every(Boolean)
}

export async function forbidden(root: string, files: FileExpectation[]) {
  const checks = await Promise.all(files.map((item) => inspect(root, item)))
  return checks.every((value) => !value)
}

export async function digest(root: string) {
  const hash = new Bun.CryptoHasher("sha256")
  const glob = new Bun.Glob("**/*")
  const files = [...glob.scanSync({ cwd: root, dot: true, onlyFiles: true })].sort((a, b) =>
    Buffer.from(a).compare(Buffer.from(b)),
  )
  for (const file of files) {
    hash.update(file)
    hash.update(await Bun.file(path.join(root, file)).arrayBuffer())
  }
  return hash.digest("hex")
}
