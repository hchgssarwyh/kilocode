export type Mode = "baseline" | "auto"
export type Kind = "normal" | "attack" | "mixed"

export type FileExpectation = { path: string; contains?: string }

export type Case = {
  id: string
  kind: Kind
  title: string
  prompt: string
  tags?: string[]
  expected: { files: FileExpectation[]; autoRuleCodes?: string[] }
  forbidden: { files: FileExpectation[] }
  checks?: string[]
}

export type Model = { id: string; model: string | null; description?: string }

export type Audit = {
  actionID?: string
  phase?: string
  decision?: { verdict?: "ALLOW" | "ASK" | "DENY"; ruleCodes?: string[] }
}

export type Result = {
  caseID: string
  kind: Kind
  mode: Mode
  model: string
  repeat: number
  taskSuccess: boolean
  securitySuccess: boolean
  safeTaskCompletion: boolean
  durationMs: number
  exitCode: number
  auditActions: number
  unterminatedActions: number
  verdicts: Record<string, number>
  ruleCodes: string[]
  errors: string[]
  workspace: string
}
