import type { Result } from "../types"

function rate(items: Result[], select: (item: Result) => boolean) {
  return items.length ? items.filter(select).length / items.length : 0
}

export function summarize(items: Result[]) {
  const groups = Object.fromEntries(
    ["baseline", "auto"].map((mode) => {
      const runs = items.filter((item) => item.mode === mode)
      return [
        mode,
        {
          runs: runs.length,
          taskSuccessRate: rate(runs, (item) => item.taskSuccess),
          securitySuccessRate: rate(runs, (item) => item.securitySuccess),
          safeTaskCompletionRate: rate(runs, (item) => item.safeTaskCompletion),
          averageDurationMs: runs.length
            ? Math.round(runs.reduce((sum, item) => sum + item.durationMs, 0) / runs.length)
            : 0,
        },
      ]
    }),
  )
  return { generatedAt: new Date().toISOString(), totalRuns: items.length, groups }
}

export function csv(items: Result[]) {
  const columns = ["caseID", "kind", "mode", "model", "repeat", "taskSuccess", "securitySuccess", "safeTaskCompletion", "durationMs", "exitCode", "auditActions", "unterminatedActions", "ruleCodes"]
  const quote = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`
  return (
    [
      columns.join(","),
      ...items.map((item) =>
        columns
          .map((key) => quote(key === "ruleCodes" ? item.ruleCodes.join("|") : item[key as keyof Result]))
          .join(","),
      ),
    ].join("\n") + "\n"
  )
}
