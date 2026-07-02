import type { ClarificationReady } from "../agent/clarification"
import type { TuiMode, TuiRipplePhase } from "./state/types"

export type {
  TuiClarificationOption,
  TuiClarificationQuestion,
  TuiClarificationState,
  TuiRipplePhase,
} from "./state/types"

export type TuiEventKind = "tool" | "task" | "plan" | "activity" | "error"

export type TuiEvidenceStatus = "passed" | "failed" | "blocked" | "running" | "skipped"
export type TuiGateStatus = "pass" | "block" | "warn" | "skip"

export type TuiEvent =
  | {
      type: "session.started"
      sessionId?: string
      repoRoot?: string
      branch?: string
      provider?: string
      model?: string
    }
  | { type: "mode.changed"; mode: TuiMode }
  | { type: "user.message"; text: string }
  | { type: "assistant.delta"; text: string }
  | { type: "assistant.final"; text: string }
  | { type: "task.assigned"; task: unknown }
  | { type: "plan.updated"; plan: unknown }
  | {
      type: "tool.started"
      id: string
      tool: string
      summary?: string
      risk?: string | number
    }
  | {
      type: "tool.finished"
      id: string
      ok: boolean
      outputSummary?: string
      durationMs?: number
    }
  | {
      type: "patch.proposed"
      txId: string
      files: string[]
      summary?: string
    }
  | {
      type: "patch.committed"
      txId: string
      files: string[]
    }
  | {
      type: "patch.rolled_back"
      txId: string
      files: string[]
      reason?: string
    }
  | {
      type: "evidence.added"
      kind: string
      status: TuiEvidenceStatus
      summary: string
      command?: string
      txId?: string
    }
  | {
      type: "gate.result"
      gate: string
      status: TuiGateStatus
      reason?: string
      profile?: string
    }
  | {
      type: "token.updated"
      inputTokens?: number
      outputTokens?: number
      contextMax?: number
      cacheHitRate?: number
      round?: number
    }
  | { type: "cost.updated"; estimatedUsd?: number }
  | { type: "error"; message: string; recoverable?: boolean }
  | { type: "ui.status"; text: string }
  | { type: "ui.telemetry"; text: string }
  | { type: "ui.model_name"; name: string }
  | { type: "ui.done"; done: boolean }
  | { type: "ui.queue_count"; count: number }
  | { type: "ui.error_line"; text: string }
  | { type: "ui.event_message"
      kind: TuiEventKind
      text: string
      dedupeKey?: string
      minIntervalMs?: number
    }
  | { type: "clarification.ready"; data: ClarificationReady }
  | { type: "ripple.phase"; phase: TuiRipplePhase }
