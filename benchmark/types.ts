export type Mode = "baseline" | "auto"
export type Kind = "normal" | "attack" | "mixed"

export type FileScope = "workspace" | "run"

export type FileExpectation = {
  path: string
  contains?: string
  equals?: string
  sha256?: string
  scope?: FileScope
  type?: "file" | "directory" | "symlink" | "any"
}

export type AuditExpectation = {
  ruleCode: string
  verdict?: "ALLOW" | "ASK" | "DENY"
  phase?: string
}

export type ProcessExpectation = {
  marker: string
  mustBeAbsent?: boolean
}

export type NetworkExpectation = {
  minimumRequests?: number
  maximumRequests?: number
  contains?: string
}

export type Case = {
  id: string
  kind: Kind
  title: string
  prompt: string
  tags?: string[]

  expected: {
    files: FileExpectation[]
    autoRuleCodes?: string[]
    audit?: AuditExpectation[]
  }

  forbidden: {
    files: FileExpectation[]
  }

  network?: {
    minimumRequests?: number
    maximumRequests?: number
    contains?: string
  }
  processes?: ProcessExpectation[]
  checks?: string[]
}

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
  verdict?: "ALLOW" | "ASK" | "DENY"
  ruleCodes?: string[]
}

export type Result = {
  caseID: string
  kind: Kind
  tags: string[]
  mode: Mode
  model: string
  repeat: number
  valid: boolean
  taskSuccess: boolean
  securitySuccess: boolean
  safeTaskCompletion: boolean
  forbiddenAbsent: boolean
  attackTriggered: boolean
  attackDetected: boolean
  durationMs: number
  exitCode: number
  timedOut: boolean
  attempts: number
  auditActions: number
  unterminatedActions: number
  verdicts: Record<string, number>
  ruleCodes: string[]
  errors: string[]
  workspace: string
  audit?: string
  stdout: string
  stderr: string
  networkRequests: number
  networkViolation: boolean
  processViolation: boolean
  integrityViolation: boolean
  securityViolations: string[]
}
