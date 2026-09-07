import path from "node:path"
import { cp, lstat, mkdir, mkdtemp, readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import type { Case, FileExpectation } from "../types"

export async function create(
  root: string,
  item: Case,
  output: string,
) {
  await mkdir(output, { recursive: true })

  const dir = await mkdtemp(
    path.join(output, `${item.id}-`),
  )

  await cp(
    path.join(
      root,
      "benchmark",
      "cases",
      item.kind,
      item.id,
      "fixture",
    ),
    dir,
    { recursive: true },
  )

  return dir
}

async function inspect(
  workspace: string,
  runRoot: string,
  item: FileExpectation,
) {
  const base =
    item.scope === "run"
      ? runRoot
      : workspace

  const full = path.resolve(base, item.path)
  const relative = path.relative(base, full)

  // Запрещаем самой проверке выходить за выбранный каталог.
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    return false
  }

  try {
    // lstat не переходит по символической ссылке.
    const info = await lstat(full)

    const expectedType = item.type ?? "file"

    if (
      expectedType === "file" &&
      !info.isFile()
    ) {
      return false
    }

    if (
      expectedType === "directory" &&
      !info.isDirectory()
    ) {
      return false
    }

    if (
      expectedType === "symlink" &&
      !info.isSymbolicLink()
    ) {
      return false
    }

    // Для type="any" достаточно существования объекта.
    if (
      expectedType === "any" &&
      !info.isFile() &&
      !info.isDirectory() &&
      !info.isSymbolicLink()
    ) {
      return false
    }

    // Содержимое можно проверять только у обычного файла.
    if (
      item.contains != null ||
      item.equals != null ||
      item.sha256 != null
    ) {
      if (!info.isFile()) {
        return false
      }

      const data = await readFile(full)

      if (
        item.contains != null &&
        !data.toString("utf8").includes(item.contains)
      ) {
        return false
      }

      if (
        item.equals != null &&
        data.toString("utf8") !== item.equals
      ) {
        return false
      }

      if (item.sha256 != null) {
        const actualHash = createHash("sha256")
          .update(data)
          .digest("hex")

        if (actualHash !== item.sha256) {
          return false
        }
      }
    }

    return true
  } catch {
    return false
  }
}

export async function expected(
  workspace: string,
  runRoot: string,
  files: FileExpectation[],
) {
  const checks = await Promise.all(
    files.map((item) =>
      inspect(workspace, runRoot, item),
    ),
  )

  return checks.every(Boolean)
}

export async function forbidden(
  workspace: string,
  runRoot: string,
  files: FileExpectation[],
) {
  const checks = await Promise.all(
    files.map((item) =>
      inspect(workspace, runRoot, item),
    ),
  )

  return checks.every((value) => !value)
}

export async function digest(root: string) {
  const hash = new Bun.CryptoHasher("sha256")
  const glob = new Bun.Glob("**/*")

  const files = [
    ...glob.scanSync({
      cwd: root,
      dot: true,
      onlyFiles: true,
    }),
  ].sort((a, b) =>
    Buffer.from(a).compare(Buffer.from(b)),
  )

  for (const file of files) {
    hash.update(file)
    hash.update(
      await Bun.file(
        path.join(root, file),
      ).arrayBuffer(),
    )
  }

  return hash.digest("hex")
}
