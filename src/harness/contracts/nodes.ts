/**
 * H11: Unified Node Runtime contract (plan §17 + GEP §5.4/5.5).
 *
 * A node is the execution primitive of the future Graph: sequential calls
 * only in H11 (no DAG / parallel writes / dynamic workflows — plan §23
 * forbids scheduler wiring before H11 acceptance). A single agent is
 * formally one LlmAgentNode; complex workflows later compose many nodes.
 *
 * NodeEvent is a lightweight side stream (local sequence + nodeRunId) that
 * never touches the run's eventSequence — trace consumers must not assume
 * cross-node monotonicity (documented in the H11 record).
 */

import type { AgentRunScope, AgentRun } from "./run"
import type { CapabilityRegistry } from "./capability"
import type { ContextSlice } from "./context"
import type { BudgetLedger, RunBudget } from "./budget"
import type { RunCancellation, TraceWriter } from "./scope"
import type { ArtifactStore } from "./artifact"
import type { EventEnvelope, HarnessEvent } from "./events"
import type { InterruptKind, HarnessInterrupt } from "./interrupt"
import type { JsonSchema } from "./schema"
import type { LoopDecision } from "../../agent/kernel/types"
import type { RunOutcome } from "./outcome"
import type { EvidenceEntry } from "../../agent/evidence-ledger"
import type { VerificationResult } from "../../verification/result"

export type NodeKind = "function" | "tool" | "llm_agent" | "verification" | "human"

/** GEP §5.4 NodeRunStatus, serial subset (no ready/skipped in H11). */
export type NodeRunStatus = "pending" | "running" | "succeeded" | "failed" | "blocked" | "cancelled"

export interface NodeUsage {
  modelCalls: number
  toolCalls: number
  inputTokens: number
  outputTokens: number
  cacheMissTokens: number
  wallTimeMs: number
}

export interface NodeDiagnostic {
  code: string
  message: string
  source?: string
  severity: "info" | "warning" | "error"
}

export interface NodeRunError {
  kind: string
  message: string
  retryable: boolean
  cause?: unknown
}

/** GEP §5.5 NodeResult, aligned + cancelled. */
export interface NodeResult<T = unknown> {
  status: "succeeded" | "failed" | "blocked" | "cancelled"
  output?: T
  evidence: EvidenceEntry[]
  diagnostics: NodeDiagnostic[]
  usage: NodeUsage
  retryable?: boolean
  error?: NodeRunError
}

/** Plan §17.1 — the node interface, verbatim. */
export interface HarnessNode<I, O> {
  id: string
  kind: NodeKind

  execute(
    context: NodeExecutionContext,
    input: I,
  ): AsyncIterable<NodeEvent>

  getResult(): Promise<NodeResult<O>>
}

/** Plan §17.3 — the node execution context, verbatim. */
export interface NodeExecutionContext {
  runId: string
  nodeRunId: string

  runScope: AgentRunScope
  capabilities: CapabilityRegistry

  context: ContextSlice
  budget: BudgetLedger
  cancellation: RunCancellation

  artifacts: ArtifactStore
  trace: TraceWriter
}

// ── Node event stream ──

export const NODE_EVENT_TYPES = {
  nodeStatus: "node.status",
  nodeOutput: "node.output",
  nodeText: "node.text",
  nodeToolCall: "node.tool.call",
  nodeToolResult: "node.tool.result",
  nodeUsage: "node.usage",
  nodeError: "node.error",
  nodeInterrupt: "node.interrupt",
  nodeArtifact: "node.artifact",
} as const

export type NodeEvent =
  | { type: "node.status"; nodeRunId: string; status: NodeRunStatus; attempt: number }
  | { type: "node.output"; nodeRunId: string; output: unknown }
  | { type: "node.text"; nodeRunId: string; text: string }
  | { type: "node.tool.call"; nodeRunId: string; toolCall: { id: string; name: string; input: unknown; sideEffect?: unknown } }
  | { type: "node.tool.result"; nodeRunId: string; toolName: string; success: boolean; content: string }
  | { type: "node.usage"; nodeRunId: string; usage: NodeUsage }
  | { type: "node.error"; nodeRunId: string; error: NodeRunError }
  | { type: "node.interrupt"; nodeRunId: string; kind: InterruptKind; prompt: string; responseSchema: JsonSchema }
  | { type: "node.artifact"; nodeRunId: string; artifactId: string }

// ── Node inputs / outputs ──

export interface AgentNodeInput {
  prompt: string
  tools?: Array<{ name: string; description?: string }>
  maxRounds?: number
  budget?: Partial<RunBudget>
  /** LEGACY_* keys pass through to AgentOptions (H1 transition mechanism). */
  metadata?: Record<string, unknown>
}

export interface AgentNodeOutput {
  text: string
  decision: LoopDecision
  outcome: RunOutcome
  usage: NodeUsage
  /** R1: evidence entries added during this node run (ledger diff). */
  evidenceIds: string[]
  /** R1: artifacts added during this node run (store diff). */
  artifactIds: string[]
  /** R1: patch transaction ids realized by this node run (from patch artifacts). */
  patchTransactionIds: string[]
  /** R1: unresolved ripple obligations at node end (honest unknown[] until the
   *  typed trace lands). */
  unresolvedRippleObligations: unknown[]
  /** R1: workspace content hash at node end. */
  resultingWorkspaceDigest: string
}

export interface ToolNodeInput {
  capabilityId: string
  params: Record<string, unknown>
  /** Caller-side tool call id; carried into policy evaluation and events (R1). */
  toolCallId?: string
}

export interface VerificationNodeInput {
  results: VerificationResult[]
  modifiedFiles?: string[]
  workspaceHash?: string
  /** H12: kernel round state carried across the node boundary — the write
   *  generation the round was verified under (evidence staleness) and an
   *  optional producedBy override (who ran the verification). Without this the
   *  node defaults to its own id and the ambient generation, which loses the
   *  kernel round's attribution. */
  kernelRoundState?: {
    generation?: number
    producedBy?: string
  }
}

export interface HumanNodeInput {
  kind: InterruptKind
  prompt: string
  responseSchema?: JsonSchema
}
