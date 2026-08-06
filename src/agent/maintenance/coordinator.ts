/**
 * L6: MaintenanceCoordinator — low-frequency housekeeping, kept out of the
 * main round control flow.
 *
 * Extracted from loop.ts. All seven maintenance operations live here:
 * forward/historical microcompact, thinking compaction, semantic recall,
 * adaptive checkpoint, knowledge distillation, and knowledge reconcile.
 * Each operation is independently disable-able and failure of maintenance
 * must never break the main task.
 *
 * loop.ts wires the position-constrained operations individually (forward
 * microcompact precedes the history push; semantic recall precedes the router
 * state update). `runMaintenance` is the composed single entry for a future
 * consolidated maintenance phase and for direct testing.
 */

import type { ProviderMessage, StreamEvent, LLMProvider } from "../../provider/types"
import type { ModelRouter } from "../../provider/router"
import type { KnowledgeBase } from "../../memory/knowledge"
import type { ThinkingStore } from "../../memory/thinking-store"
import type { AgentRunState, RoundToolCall } from "../run/types"
import type { PlanStore } from "../run/plan-store"
import type { AgentRunTrace } from "../run-trace"
import { collectThinkingRounds, compactHistoricalToolResults, microcompactToolResults } from "../round/post-loop"
import { compactThinkingChain } from "../../memory/compactor"
import { streamProviderRoundEvents } from "../provider/round-runner"
import { formatSkippedProviderPurpose, shouldSkipProviderPurpose } from "../../provider/cost-policy"
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
  abortSignal?: AbortSignal
  thinkingStore?: ThinkingStore
  /** Mutable — thinking compaction rewrites the in-memory cold memory slice. */
  stableMemoryContext?: string
  effectivePrompt: string
  /** Router state roundNum — semantic recall gates on the pre-update value. */
  routerRoundNum: number

  execution: AgentRunState["execution"]
  verificationState: AgentRunState["verification"]
  runState: AgentRunState
  planning: AgentRunState["planning"]
  maintenance: AgentRunState["maintenance"]
  budget: AgentRunState["budget"]
  planStore: PlanStore
  taskFiles: Set<string>

  rawMessages: ProviderMessage[]
  resultsContent: Array<Record<string, unknown>>
  completedToolCalls: RoundToolCall[]
  learnPrompts: string[]

  preRoundCtx: { contextBudgetPercent: number; contextBudgetMode?: string }
  runTrace?: AgentRunTrace
}

/** RC-13 E3: 追加用户侧上下文——与相邻 user 消息合并，杜绝连续 user 消息
 *  （违反 provider 角色交替约束）。tool_results 数组消息 → append text block；
 *  字符串消息 → 拼接；否则新消息。 */
export function appendUserContext(rawMessages: ProviderMessage[], content: string): void {
  const last = rawMessages[rawMessages.length - 1]
  if (last && last.role === "user") {
    if (Array.isArray(last.content)) {
      ;(last.content as Array<Record<string, unknown>>).push({ type: "text", text: content })
      return
    }
    if (typeof last.content === "string") {
      last.content = last.content + "\n\n" + content
      return
    }
  }
  rawMessages.push({ role: "user", content })
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
      sessionId: process.env.ORCANA_SESSION_ID ?? "ds-default",
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
  try {
    if (!ctx.knowledgeBase || ctx.learnPrompts.length === 0) return
    for (const tc of ctx.completedToolCalls) {
      // RC-13 E4: tc.input 可能缺失——guard 防御，同步异常不得打穿整个 round。
      if (!tc.input) continue
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
  } catch (e) {
    ctx.runTrace?.record("maintenance_error", {
      component: "knowledge_distillation",
      recoverable: true,
      message: e instanceof Error ? e.message : String(e),
    })
  }
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

// ── Forward microcompact (before tool results enter history) ──

/**
 * Compact fresh tool results before they enter history (forward pass).
 * Position-constrained: must run before resultsContent is pushed into rawMessages.
 */
export async function* runForwardMicrocompact(ctx: MaintenanceContext): AsyncGenerator<StreamEvent, void, unknown> {
  const should = ctx.preRoundCtx.contextBudgetPercent >= 35
    || ctx.rawMessages.length >= 40
    || ctx.epochAction === "compress"
    || ctx.epochAction === "forceCompress"
    || ctx.epochAction === "rollover"
  if (!should) return
  const mcResult = microcompactToolResults(ctx.resultsContent, ctx.completedToolCalls)
  while (ctx.resultsContent.length > 0) ctx.resultsContent.pop()
  for (const r of mcResult.results) ctx.resultsContent.push(r)
  if (mcResult.compacted > 0) {
    ctx.budget.microcompactCount += mcResult.compacted
    yield { type: "status", data: `microcompact: ${mcResult.compacted} tool results compacted (${ctx.budget.microcompactCount} total)` }
  }
}

// ── Thinking compaction (one-shot per session) ──

/**
 * One-shot thinking-chain compaction triggered by epoch force-compress or
 * 40%+ budget. Compacts collected thinking rounds through the provider, merges
 * insights into cold memory, and appends a volatile summary message without
 * invalidating the frozen stable prefix.
 */
export async function* runThinkingCompaction(ctx: MaintenanceContext): AsyncGenerator<StreamEvent, void, unknown> {
  if (
    ctx.maintenance.thinkingCompacted ||
    ctx.preRoundCtx.contextBudgetMode !== "normal" ||
    !ctx.thinkingStore
  ) return
  const triggered = ctx.preRoundCtx.contextBudgetPercent >= 40
    || ctx.epochAction === "forceCompress"
    || ctx.epochAction === "rollover"
  if (!triggered) return

  const thinkingRounds = collectThinkingRounds(ctx.rawMessages)
  if (thinkingRounds.length < 2) return

  if (shouldSkipProviderPurpose("thinking_compaction")) {
    yield { type: "status", data: formatSkippedProviderPurpose("thinking_compaction") }
    ctx.runTrace?.record("gate_decision", { gate: "cost_mode", decision: "skip", purpose: "thinking_compaction" })
    return
  }

  yield { type: "status", data: `thinking-compaction: ${thinkingRounds.length} rounds → analyzing...` }
  try {
    const compactResult = await compactThinkingChain(
      thinkingRounds,
      async function* (system, prompt) {
        for await (const ev of streamProviderRoundEvents({
          provider: ctx.provider,
          request: {
            model: ctx.modelRouter?.selectForPurpose("thinking_compaction") ?? "deepseek-v4-flash",
            purpose: "thinking_compaction",
            system,
            messages: [{ role: "user", content: prompt }],
            maxTokens: 1024,
          },
          abortSignal: ctx.abortSignal,
        })) {
          yield ev
        }
      },
    )
    if (compactResult.success) {
      const mergeResult = ctx.thinkingStore.mergeCompressedInsights(
        ctx.stableMemoryContext ?? "",
        compactResult.output,
      )
      const insightCount = compactResult.output.key_insights.length +
        compactResult.output.discarded.length +
        compactResult.output.verified.length +
        compactResult.output.open.length

      if (mergeResult.changed) {
        // Inject updated cold memory as a user message — does NOT mutate
        // rawMessages beyond the append and does not invalidate the frozen
        // stable prefix (prefix cache continuity preserved).
        const compactSummary = [
          "<system-reminder>",
          "思考链已压实。以下是从本次会话推理中提取的关键洞察（已去重并存入冷记忆）：",
          ...compactResult.output.key_insights.map((k, i) => `${i + 1}. [insight] ${k}`),
          ...compactResult.output.verified.map((v, i) => `✓ [verified] ${v}`),
          ...compactResult.output.open.map((o, i) => `? [open] ${o}`),
          "</system-reminder>",
        ].join("\n")
        appendUserContext(ctx.rawMessages, compactSummary)
        ctx.stableMemoryContext = mergeResult.merged
        yield { type: "status", data: `thinking-compaction: ${thinkingRounds.length} rounds → ${insightCount} insights (appended, cache preserved)` }
      }

      ctx.thinkingStore.storeCompressed({
        query: ctx.effectivePrompt,
        compactOutput: compactResult.output,
        roundRange: `r${thinkingRounds[0]?.roundNum ?? 0}-r${thinkingRounds[thinkingRounds.length - 1]?.roundNum ?? ctx.round}`,
        filePattern: [...ctx.taskFiles].join(","),
      })
      ctx.maintenance.thinkingCompacted = true
      yield { type: "status", data: `thinking-compaction: ${thinkingRounds.length} rounds → ${insightCount} insights` }
    }
  } catch {
    yield { type: "status", data: "thinking-compaction: failed, keeping full chains" }
  }
}

// ── Semantic recall (L3 volatile, historical context injection) ──

/**
 * Inject similar historical thinking notes as volatile context every 3 router
 * rounds. Best-effort: failures never break the main task.
 */
export async function* runSemanticRecall(ctx: MaintenanceContext): AsyncGenerator<StreamEvent, void, unknown> {
  if (!ctx.thinkingStore || ctx.round <= 0 || ctx.routerRoundNum % 3 !== 0) return

  if (shouldSkipProviderPurpose("semantic_recall_score")) {
    yield { type: "status", data: formatSkippedProviderPurpose("semantic_recall_score") }
    ctx.runTrace?.record("gate_decision", { gate: "cost_mode", decision: "skip", purpose: "semantic_recall_score" })
    return
  }

  try {
    const semanticRecords = await ctx.thinkingStore.findSimilarSemantic(
      ctx.effectivePrompt,
      async (query, candidates) => {
        const lines = candidates.map((c, i) => `候选${i + 1}: ${c.queryPreview.slice(0, 80)}`).join("\n")
        const prompt = `当前问题: "${query.slice(0, 120)}"\n\n对以下每个候选与当前问题的相关性从0-10打分，只输出逗号分隔的数字:\n${lines}\n\n输出格式: 8,3,9,1,6,...`
        const scores: number[] = []
        try {
          for await (const ev of streamProviderRoundEvents({
            provider: ctx.provider,
            request: {
              model: ctx.modelRouter?.selectForPurpose("semantic_recall_score") ?? "deepseek-v4-flash",
              purpose: "semantic_recall_score",
              system: "你是相关性打分器。只输出数字。",
              messages: [{ role: "user", content: prompt }],
              maxTokens: 128,
            },
            abortSignal: ctx.abortSignal,
          })) {
            if (ev.type === "text" && typeof ev.data === "string") {
              for (const part of ev.data.split(",")) {
                const n = parseInt(part.trim(), 10)
                if (!isNaN(n)) scores.push(n)
              }
            }
          }
        } catch { /* fall through to keyword results */ }
        return scores
      },
    )
    if (semanticRecords.length > 0) {
      const historicalContext = ctx.thinkingStore.formatForVolatileContext(semanticRecords)
      if (historicalContext) {
        // Inject as an additional user message before the next round.
        // This goes into L3 volatile — does NOT affect prefix cache.
        appendUserContext(ctx.rawMessages, historicalContext)
      }
    }
  } catch { /* semantic recall is best-effort */ }
}

// ── Composed single entry ──

/**
 * Single maintenance entry that runs every low-frequency housekeeping operation.
 *
 * NOTE: loop.ts wires the position-constrained operations individually (forward
 * microcompact must precede the history push; semantic recall must precede the
 * router state update). `runMaintenance` is the composed API for a future
 * consolidated maintenance phase and for direct testing.
 */
export async function* runMaintenance(ctx: MaintenanceContext): AsyncGenerator<StreamEvent, void, unknown> {
  yield* runForwardMicrocompact(ctx)
  yield* runHistoricalMicrocompact(ctx)
  yield* runThinkingCompaction(ctx)
  yield* runSemanticRecall(ctx)
  yield* runAdaptiveCheckpoint(ctx)
  runKnowledgeDistillation(ctx)
  yield* runKnowledgeReconcile(ctx)
}
