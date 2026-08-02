/**
 * L6: MaintenanceCoordinator — low-frequency housekeeping, kept out of the
 * main round control flow.
 *
 * Extracted from loop.ts. Each operation is independently disable-able and
 * failure of maintenance must never break the main task. The provider-coupled
 * maintenance (thinking compaction, semantic recall) stays in loop.ts for now;
 * it is tracked as a remaining L6 item in the ALK plan.
 */

import type { ProviderMessage, StreamEvent, LLMProvider } from "../../provider/types"
import type { ModelRouter } from "../../provider/router"
import type { KnowledgeBase } from "../../memory/knowledge"
import type { AgentRunState, RoundToolCall } from "../run/types"
import type { PlanStore } from "../run/plan-store"
import type { AgentRunTrace } from "../run-trace"
import { compactHistoricalToolResults } from "../round/post-loop"
import {
  adaptiveCheckpointThreshold,
  formatCheckpointSummary,
  generateCheckpointId,
  recordCheckpointTaken,
  saveCheckpoint,
  shouldSkipCheckpointThisRound,
} from "../../session/checkpoint"
import { distillAndStore, shouldDistill } from "../../memory/distiller"
import { planProgress } from "../master-plan"

export interface MaintenanceContext {
  round: number
  epochAction: string
  provider: LLMProvider
  modelRouter?: ModelRouter
  knowledgeBase?: KnowledgeBase

  execution: AgentRunState["execution"]
  verificationState: AgentRunState["verification"]
  runState: AgentRunState
  planning: AgentRunState["planning"]
  budget: AgentRunState["budget"]
  planStore: PlanStore
  taskFiles: Set<string>

  rawMessages: ProviderMessage[]
  resultsContent: Array<Record<string, unknown>>
  completedToolCalls: RoundToolCall[]
  learnPrompts: string[]

  preRoundCtx: { contextBudgetPercent: number }
  runTrace?: AgentRunTrace
}

// ── Historical microcompact (retrospective pass) ──

/**
 * Compact historical tool results every 10 rounds, or on epoch force-compress /
 * rollover. Preserves the `tool_use → tool_result` adjacency.
 */
export async function* runHistoricalMicrocompact(
  ctx: MaintenanceContext,
): AsyncGenerator<StreamEvent, void, unknown> {
  if (ctx.round >= 15 && ctx.round % 10 === 0 || ctx.epochAction === "forceCompress" || ctx.epochAction === "rollover") {
    const histCompacted = compactHistoricalToolResults(ctx.rawMessages, 8)
    if (histCompacted > 0) {
      ctx.budget.microcompactCount += histCompacted
      yield { type: "status", data: `microcompact: ${histCompacted} historical results compacted (${ctx.budget.microcompactCount} total)` }
    }
  }
}

// ── Adaptive checkpoint ──

/**
 * Adaptive checkpoint based on context-budget density and run complexity.
 * Failure of checkpoint must be observable but never abort the main task.
 */
export async function* runAdaptiveCheckpoint(
  ctx: MaintenanceContext,
): AsyncGenerator<StreamEvent, void, unknown> {
  const metrics = {
    filesPerRound: ctx.round > 0 ? ctx.execution.modifiedFileCount / ctx.round : 0,
    errorRate: ctx.round > 0 ? ctx.execution.toolErrors / ctx.round : 0,
    round: ctx.round,
  }
  const cpDecision = adaptiveCheckpointThreshold(ctx.preRoundCtx.contextBudgetPercent, metrics)
  if (cpDecision && !shouldSkipCheckpointThisRound(ctx.round)) {
    yield { type: "status", data: `checkpoint: ${cpDecision.label} (${cpDecision.urgency})` }
    const masterPlan = ctx.planStore.current ? {
      goal: ctx.planStore.current.goal,
      nodes: ctx.planStore.current.nodes.map(n => ({ id: n.id, title: n.title, status: n.status })),
      current: ctx.planStore.current.current,
      progress: planProgress(ctx.planStore.current),
    } : (ctx.planning.taskTracker ? { goal: ctx.planning.taskTracker.goal, steps: ctx.planning.taskTracker.steps.map(s => ({ id: s.id, status: s.status, title: s.title })) } : {})
    const taskSteps = ctx.planning.taskTracker?.steps.map(s => ({ id: s.id, status: s.status, title: s.title })) ?? []
    const changedFiles = [...ctx.taskFiles]
    const coldMemorySHA = ctx.runState.conversation.stablePrefixHash
    const lastVerification = ctx.verificationState.lastTypecheck
      ? { kind: "typecheck", passed: ctx.verificationState.lastTypecheck.passed, command: "tsc --noEmit" }
      : null
    const conversationTokens = ctx.preRoundCtx.contextBudgetPercent > 0
      ? Math.round(ctx.preRoundCtx.contextBudgetPercent * 1000)
      : 0

    saveCheckpoint({
      version: 1,
      checkpointId: generateCheckpointId(),
      round: ctx.round,
      timestamp: Date.now(),
      sessionId: process.env.DEEPSEEK_SESSION_ID ?? "ds-default",
      masterPlan,
      taskSteps,
      changedFiles,
      fileSHAs: {},
      coldMemorySHA,
      knowledgeCount: 0,
      lastVerification,
      conversationTokens,
      prevRound: ctx.round,
      summary: formatCheckpointSummary({
        version: 1,
        checkpointId: generateCheckpointId(),
        round: ctx.round,
        timestamp: Date.now(),
        sessionId: "",
        masterPlan: ctx.planning.taskTracker ? { goal: ctx.planning.taskTracker.goal, steps: ctx.planning.taskTracker.steps } : {},
        taskSteps: ctx.planning.taskTracker?.steps ?? [],
        changedFiles,
        fileSHAs: {},
        coldMemorySHA,
        knowledgeCount: 0,
        lastVerification,
        conversationTokens: Math.round(ctx.preRoundCtx.contextBudgetPercent * 1000),
        prevRound: ctx.round,
        summary: ctx.planStore.current
          ? `Round ${ctx.round}: ${planProgress(ctx.planStore.current)}, ${ctx.execution.modifiedFileCount} files, ${ctx.execution.toolErrors} errors`
          : `Round ${ctx.round}: ${ctx.execution.modifiedFileCount} files, ${ctx.execution.toolErrors} errors`,
      }),
    })
    recordCheckpointTaken(ctx.round)
    ctx.runTrace?.record("checkpoint", { label: cpDecision.label, round: ctx.round, metrics })
  }
}

// ── Knowledge distillation (web_search → KB) ──

/**
 * Best-effort distillation of web_search results into the knowledge base.
 * Fire-and-forget: failures never block the next round.
 */
export function runKnowledgeDistillation(ctx: MaintenanceContext): void {
  if (!ctx.knowledgeBase || ctx.learnPrompts.length === 0) return
  for (const tc of ctx.completedToolCalls) {
    if (tc.name !== "web_search") continue
    const query = (tc.input as Record<string, unknown>).query as string | undefined
    if (!query || !shouldDistill(query, "error")) continue
    const resultEntry = ctx.resultsContent.find(r => r.tool_use_id === tc.id)
    if (!resultEntry) continue
    const resultText = String(resultEntry.content ?? "")
    if (!resultText.includes("[SearXNG]") && !resultText.includes("[DuckDuckGo]")) continue
    // Fire distillation (best-effort, don't block next round if it fails)
    distillAndStore(
      { query, results: resultText, trigger: "error" },
      ctx.provider,
      ctx.knowledgeBase,
      ctx.modelRouter?.selectForPurpose("knowledge_distill") ?? "deepseek-v4-flash",
    ).catch(() => {})
  }
}

// ── Memory reconcile (periodic prune + FTS5 rebuild) ──

/**
 * Periodic knowledge-base prune + index rebuild. Failure must not break the run.
 */
export async function* runKnowledgeReconcile(
  ctx: MaintenanceContext,
): AsyncGenerator<StreamEvent, void, unknown> {
  if (ctx.knowledgeBase && ctx.round > 0 && ctx.round % 50 === 0) {
    const recResult = ctx.knowledgeBase.reconcile()
    if (recResult.pruned > 0) {
      yield { type: "status", data: `knowledge-reconcile: pruned ${recResult.pruned} expired, ${recResult.indexed} active` }
    }
  }
}
