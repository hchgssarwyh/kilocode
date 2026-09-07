import { constants } from "node:fs"
import { chmod, copyFile, lstat, mkdir, readdir, readlink, symlink } from "node:fs/promises"
import path from "node:path"

export namespace Copy {
  export type Backend = {
    tree(source: string, target: string): Promise<void>
    entry(source: string, target: string): Promise<void>
  }

  function inside(root: string, target: string) {
    const rel = path.relative(root, target)
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
  }

  async function item(source: string, target: string, tree: boolean, root?: string): Promise<void> {
    const info = await lstat(source)
    if (info.isSymbolicLink()) {
      const link = await readlink(source)
      const resolved = path.resolve(path.dirname(source), link)
      if (root && (path.isAbsolute(link) || !inside(root, resolved))) {
        throw new Error("Auto Mode cannot materialize an absolute or escaping symlink")
      }
      await symlink(link, target)
      return
    }
    if (info.isFile()) {
      await copyFile(source, target, constants.COPYFILE_EXCL)
      await chmod(target, info.mode & 0o777)
      return
    }
    if (!info.isDirectory()) throw new Error("Auto Mode cannot copy an unsupported filesystem entry")

    await mkdir(target, { mode: info.mode & 0o777 })
    if (!tree) return
    const names = await readdir(source)
    names.sort((a, b) => Buffer.from(a).compare(Buffer.from(b)))
    for (const name of names) {
      if (name === ".git") continue
      await item(path.join(source, name), path.join(target, name), true, root ?? source)
    }
    await chmod(target, info.mode & 0o777)
  }

  export const local: Backend = {
    async tree(source, target) {
      await item(source, target, true, source)
    },
    async entry(source, target) {
      await item(source, target, false)
    },
  }
}
