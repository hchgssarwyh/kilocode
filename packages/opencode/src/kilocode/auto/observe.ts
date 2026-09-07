import type { ActionEffect } from "./types"
import type { Manifest } from "./manifest"

export namespace Observe {
  export type Result = {
    effects: readonly ActionEffect[]
    diagnostics: readonly Manifest.Diagnostic[]
  }

  function effect(entry: Manifest.Entry): ActionEffect | undefined {
    if (entry.kind === "symlink") {
      return {
        category: "file.symlink",
        path: entry.path,
        target: entry.target,
        fingerprint: entry.fingerprint,
      }
    }
    if (entry.kind === "directory") return
    return { category: "file.write", path: entry.path, fingerprint: entry.fingerprint }
  }

  function changed(before: Manifest.Entry, after: Manifest.Entry) {
    if (before.kind !== after.kind) return true
    if (before.executable !== after.executable) return true
    if (before.target !== after.target) return true
    return before.fingerprint !== after.fingerprint
  }

  export function diff(before: Manifest.Info, after: Manifest.Info): Result {
    const diagnostics = [...before.diagnostics, ...after.diagnostics]
    if (before.root !== after.root) diagnostics.push({ code: "race" })
    if (diagnostics.length) return { effects: [{ category: "unknown" }], diagnostics }

    const previous = new Map(before.entries.map((entry) => [entry.path, entry]))
    const current = new Map(after.entries.map((entry) => [entry.path, entry]))
    const paths = [...new Set([...previous.keys(), ...current.keys()])].sort((a, b) =>
      Buffer.from(a).compare(Buffer.from(b)),
    )
    const effects: ActionEffect[] = []
    for (const path of paths) {
      const left = previous.get(path)
      const right = current.get(path)
      if (!left && right) {
        const created = effect(right)
        if (created) effects.push(created)
        continue
      }
      if (left && !right) {
        if (left.kind !== "directory") {
          effects.push({ category: "file.delete", path, fingerprint: left.fingerprint })
        }
        continue
      }
      if (!left || !right || !changed(left, right)) continue
      if (left.kind !== right.kind && left.kind !== "directory") {
        effects.push({ category: "file.delete", path, fingerprint: left.fingerprint })
      }
      const updated = effect(right)
      if (updated) effects.push(updated)
    }
    return { effects, diagnostics }
  }
}
