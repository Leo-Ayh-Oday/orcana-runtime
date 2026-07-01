import type { ClarificationQuestion } from "../../agent/clarification"
import type { TuiEventKind, TuiEvidenceStatus, TuiGateStatus } from "../events"

export type TuiMode =
  | "discussion"
  | "readonly"
  | "narrow_edit"
  | "long_task"
  | "planner"
  | "executor"

export interface TuiSessionState {
  sessionId?: string
  repoRoot?: string
  branch?: string
  provider?: string
  model?: string
}

export interface TuiMessage {
  id: string
  role: "user" | "assistant" | "event"
  text: string
  kind?: TuiEventKind
  pending?: boolean
  error?: boolean
  createdAt: number
}

export interface TuiToolEvent {
  id: string
  tool: string
  status: "running" | "passed" | "failed" | "orphan"
  summary?: string
  risk?: string | number
  outputSummary?: string
  startedAt?: number
  finishedAt?: number
  durationMs?: number
}

export interface TuiPatchEvent {
  txId: string
  status: "proposed" | "committed" | "rolled_back"
  files: string[]
  summary?: string
  reason?: string
  createdAt: number
}

export interface TuiEvidenceEvent {
  id: string
  kind: string
  status: TuiEvidenceStatus
  summary: string
  command?: string
  txId?: string
  createdAt: number
}

export interface TuiGateEvent {
  id: string
  gate: string
  status: TuiGateStatus
  reason?: string
  profile?: string
  createdAt: number
}

export interface TuiErrorEvent {
  id: string
  message: string
  recoverable?: boolean
  createdAt: number
}

export interface TuiTokenState {
  inputTokens: number
  outputTokens: number
  contextMax: number
  cacheHitRate?: number
}

export interface TuiCostState {
  estimatedUsd?: number
}

export interface TuiClarificationOption {
  key: string
  label: string
  recommended?: boolean
}

export interface TuiClarificationQuestion {
  id: string
  title: string
  options: TuiClarificationOption[]
}

export interface TuiClarificationState {
  originalPrompt: string
  questions: TuiClarificationQuestion[]
  index: number
  selected: number
  answers: Array<{ question: string; key: string; label: string }>
  extraPrompt?: string
  rawText: string
}

export interface TuiRippleFinding {
  file: string
  severity: string
  reason: string
}

/** 涟漪引擎运行态阶段（PR-5）。
 *  idle → scan → propagate → verify → settled/blocked → idle */
export type TuiRipplePhase = "idle" | "scan" | "propagate" | "verify" | "blocked" | "settled"

export interface TuiDashToolHistoryEntry {
  name: string
  status: "running" | "done" | "blocked" | "error"
}

export interface TuiState {
  session: TuiSessionState
  mode: TuiMode
  messages: TuiMessage[]
  streamingText: string
  tools: TuiToolEvent[]
  patches: TuiPatchEvent[]
  evidence: TuiEvidenceEvent[]
  gates: TuiGateEvent[]
  errors: TuiErrorEvent[]
  tokens: TuiTokenState
  cost: TuiCostState
  status: string
  telemetry: string
  modelName: string
  done: boolean
  queueCount: number
  errorLine: string
  task?: unknown
  plan?: unknown
  clarification?: TuiClarificationState
  round: number
  cacheHitHistory: number[]
  rippleFindings: TuiRippleFinding[]
  /** PR-5: 涟漪引擎当前阶段，用于 RuntimePanel 动画 */
  ripplePhase: TuiRipplePhase
  dashToolHistory: TuiDashToolHistoryEntry[]
  _nextId: number
  _lastEventKey: string | null
  _lastEventAt: number
}

export function toTuiClarificationQuestion(question: ClarificationQuestion): TuiClarificationQuestion {
  return {
    id: question.id,
    title: question.title,
    options: question.options.map(option => ({
      key: option.key,
      label: option.label,
      recommended: option.recommended,
    })),
  }
}
