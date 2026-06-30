export type RuntimeStatus =
  | "idle"
  | "planning"
  | "running"
  | "waiting_approval"
  | "blocked"
  | "done"
  | "error"

export type RiskLevel = "low" | "medium" | "high" | "critical"

export type PanelId =
  | "conversation"
  | "plan"
  | "evidence"
  | "gates"
  | "file_state"
  | "tools"
  | "skills"
  | "trace"
  | "checkpoint"
  | "context"
  | "children"
  | "cost"

export interface RuntimePlanStep {
  id: string
  title: string
  status: "pending" | "running" | "passed" | "failed" | "blocked" | "skipped"
  summary?: string
}

export interface ApprovalRequest {
  requestId: string
  kind: "plan" | "tool" | "patch" | "risk"
  title: string
  summary?: string
  riskLevel?: RiskLevel
}

export interface ToolCallPreview {
  callId: string
  toolName: string
  summary?: string
  riskLevel?: RiskLevel
  argsPreview?: string
}

export interface ToolCallResultSummary {
  ok: boolean
  summary: string
  durationMs?: number
  evidenceIds?: string[]
}

export interface RuntimeEvidence {
  id: string
  kind: string
  passed: boolean
  summary: string
  command?: string
  txId?: string
}

export interface FileStateRecordSummary {
  path: string
  status: "fresh" | "changed" | "stale" | "partial" | "truncated" | "deleted" | "missing"
  summary?: string
}

export interface ContextProjectionSummary {
  projectionId: string
  stableItems: number
  recentTurns: number
  resultPreviews: number
  compactBoundaries: number
  summary?: string
}

export interface RuntimeSkillMatch {
  name: string
  reason?: string
  confidence?: number
  status?: "builtin" | "active" | "candidate" | "quarantined" | "deprecated"
}

export interface SkillGapReport {
  requestedCapability: string
  shouldForgeSkill: boolean
  riskLevel?: RiskLevel
  reasons: string[]
}

export interface ChildSessionSummary {
  id: string
  role: string
  status: "running" | "blocked" | "done" | "failed"
  summary?: string
}

export type RuntimeEvent =
  | { type: "session.started"; sessionId: string; repoRoot: string; timestamp: number }
  | { type: "session.status"; status: RuntimeStatus; timestamp: number }
  | { type: "agent.round.started"; round: number; mode?: string; timestamp: number }
  | { type: "agent.token"; text: string; channel: "answer" | "thinking" | "tool"; timestamp: number }
  | { type: "agent.round.completed"; round: number; timestamp: number }
  | { type: "plan.updated"; planId: string; steps: RuntimePlanStep[]; timestamp: number }
  | { type: "approval.required"; request: ApprovalRequest; timestamp: number }
  | { type: "tool.call.proposed"; call: ToolCallPreview; timestamp: number }
  | { type: "tool.call.started"; callId: string; timestamp: number }
  | { type: "tool.call.completed"; callId: string; result: ToolCallResultSummary; timestamp: number }
  | { type: "gate.blocked"; gate: string; reason: string; riskLevel?: RiskLevel; timestamp: number }
  | { type: "evidence.added"; evidence: RuntimeEvidence; timestamp: number }
  | { type: "file_state.updated"; record: FileStateRecordSummary; timestamp: number }
  | { type: "context.projected"; summary: ContextProjectionSummary; timestamp: number }
  | { type: "skill.selected"; skills: RuntimeSkillMatch[]; timestamp: number }
  | { type: "skill.gap.detected"; gap: SkillGapReport; timestamp: number }
  | { type: "child_session.updated"; child: ChildSessionSummary; timestamp: number }
  | { type: "error"; error: string; recoverable: boolean; timestamp: number }

export type UserIntent =
  | { type: "submit_prompt"; text: string }
  | { type: "queue_message"; text: string; injectionPolicy: "next_round" | "after_tool" | "after_plan" }
  | { type: "slash_command"; raw: string }
  | { type: "interrupt" }
  | { type: "approve_plan"; planId: string }
  | { type: "reject_plan"; planId: string; reason?: string }
  | { type: "approve_tool"; callId: string }
  | { type: "deny_tool"; callId: string; reason?: string }
  | { type: "rewind"; checkpointId: string }
  | { type: "open_panel"; panel: PanelId }
