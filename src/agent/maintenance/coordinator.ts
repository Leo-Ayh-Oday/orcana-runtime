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
import type { ThinkingStore, CompactOutput } from "../../memory/thinking-store"
import type { AgentRunState, RoundToolCall } from "../run/types"
import type { PlanStore } from "../run/plan-store"
import type { AgentRunTrace } from "../run-trace"
import { collectThinkingRounds, compactHistoricalToolResults, mcThreshold, microcompactToolResults } from "../round/post-loop"
import type { ArtifactStore } from "../../harness/contracts/artifact"
import { compactThinkingChain } from "../../memory/compactor"
import { streamProviderRoundEvents } from "../provider/round-runner"
import { formatSkippedProviderPurpose, shouldSkipProviderPurpose } from "../../provider/cost-policy"
import {
  adaptiveCheckpointThreshold,
  buildSessionCheckpoint,
  formatCheckpointSummary,
  recordCheckpointTaken,
  saveCheckpoint,
  shouldSkipCheckpointThisRound,
} from "../../session/checkpoint"
import { distillAndStore, shouldDistill } from "../../memory/distiller"
import { currentTransactionEvidenceBinding } from "../patch-transaction"
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
  /** K36 (RC-18): 写穿钩子——把 compaction 合并后的冷记忆写回 K35 稳定前缀源
   *  （round.ts 的 `options.stableMemoryContext`）。round.ts 接线后，下一轮
   *  源指纹将检测到变化并重建 frozen stable prefix。未接线时仅更新本地
   *  stableMemoryContext（原行为）。注：round.ts 的 maintenanceCtx 字段是
   *  options.stableMemoryContext 的拷贝，直接改本地字段不会传播到指纹源，
   *  故需此写穿机制。 */
  stableMemoryWriteThrough?: (merged: string) => void
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
  /** K5: 压缩前持久化完整 Tool Output 的 Artifact Store（生产路径由 harness 注入）。 */
  artifactStore?: ArtifactStore
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
    // D3 (RC-11): checkpoint 必须使用真实会话 id——优先 runState.identity.sessionId
    // （kernel/context.ts 已接线），回退 ORCANA_SESSION_ID env，最后 ds-default。
    const sessionId = ctx.runState.identity.sessionId ?? process.env.ORCANA_SESSION_ID ?? "ds-default"
    yield { type: "status", data: `checkpoint: ${cpDecision.label} (${cpDecision.urgency})` }
    const masterPlan = ctx.planStore.current ? {
      goal: ctx.planStore.current.goal,
      nodes: ctx.planStore.current.nodes.map(n => ({ id: n.id, title: n.title, status: n.status })),
      current: ctx.planStore.current.current,
      progress: planProgress(ctx.planStore.current),
    } : (ctx.planning.taskTracker ? { goal: ctx.planning.taskTracker.goal, steps: ctx.planning.taskTracker.steps.map(s => ({ id: s.id, status: s.status, title: s.title })) } : {})
    const taskSteps = ctx.planning.taskTracker?.steps.map(s => ({ id: s.id, status: s.status, title: s.title })) ?? []
    // TB2-1: checkpoint 变更文件只含真正修改的文件（写工具成功），只读观察不算。
    // （测试/旧 ctx 可能没有该字段——防御性回退。）
    const changedFiles = [...(ctx.execution.modifiedFiles ?? [])]
    const coldMemorySHA = ctx.runState.conversation.stablePrefixHash
    const lastVerification = ctx.verificationState.lastTypecheck
      ? { kind: "typecheck", passed: ctx.verificationState.lastTypecheck.passed, command: "tsc --noEmit" }
      : null
    const conversationTokens = ctx.preRoundCtx.contextBudgetPercent > 0
      ? Math.round(ctx.preRoundCtx.contextBudgetPercent * 1000)
      : 0
    const cp = buildSessionCheckpoint({
      sessionId,
      round: ctx.round,
      masterPlan,
      taskSteps,
      changedFiles,
      coldMemorySHA,
      lastVerification,
      conversationTokens,
      summary: "",
    })
    // summary 由 checkpoint 自身字段格式化（§1~§6 模板）。
    cp.summary = formatCheckpointSummary(cp)
    saveCheckpoint(cp)
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

  // ── K5: 压缩前先持久化完整 Tool Output 到 Artifact Store（异步），再以同步
  // map 钩子交给 microcompactToolResults 写入 placeholder。失败结果（K25 Pin）
  // 不持久化——完整内容本就保留。best-effort：持久化失败不阻断压缩。
  let refByToolUseId: Map<string, string> | null = null
  if (ctx.artifactStore) {
    refByToolUseId = new Map()
    const nameById = new Map(ctx.completedToolCalls.map(tc => [tc.id, tc]))
    for (const r of ctx.resultsContent) {
      if (r.type !== "tool_result" || typeof r.content !== "string" || r.content.length < 100) continue
      const tc = nameById.get(String(r.tool_use_id ?? ""))
      if (!tc) continue
      if (r.is_error === true) continue // K25: 失败 Pin——不压缩也不持久化
      const threshold = mcThreshold(tc.name)
      if (threshold <= 0 || r.content.length <= threshold) continue
      try {
        const ref = await ctx.artifactStore.storeContent(r.content)
        refByToolUseId.set(String(r.tool_use_id ?? ""), ref)
      } catch { /* best-effort */ }
    }
  }
  const mcResult = microcompactToolResults(
    ctx.resultsContent,
    ctx.completedToolCalls,
    refByToolUseId
      ? (content, meta) => refByToolUseId!.get(meta.toolUseId) ?? null
      : undefined,
  )
  while (ctx.resultsContent.length > 0) ctx.resultsContent.pop()
  for (const r of mcResult.results) ctx.resultsContent.push(r)
  if (mcResult.compacted > 0) {
    ctx.budget.microcompactCount += mcResult.compacted
    yield { type: "status", data: `microcompact: ${mcResult.compacted} tool results compacted (${ctx.budget.microcompactCount} total)` }
  }
}

// ── Thinking compaction (one-shot per session) ──

/**
 * K8 (RC-18): 计算 thinking compaction 的证据锚。
 *
 * 优先使用当前提交 transaction 绑定（stateId/transactionCount/latestTransactionId）
 * ——这是可溯源的 commit 历史身份；再附 evidence ledger 条目数作为轻量 digest。
 * 无任何证据状态时返回 undefined（行为不退化——verified 洞察不带锚也正常合并）。
 */
function compactionEvidenceAnchor(ctx: MaintenanceContext): string | undefined {
  const binding = currentTransactionEvidenceBinding()
  const ledgerEntries = ctx.verificationState?.evidenceLedger?.entries?.length ?? 0
  const parts: string[] = []
  if (binding) {
    parts.push(`tx=${binding.latestTransactionId} state=${binding.stateId} count=${binding.transactionCount}`)
  }
  if (ledgerEntries > 0) {
    parts.push(`ledger=${ledgerEntries}`)
  }
  return parts.length > 0 ? parts.join(" ") : undefined
}


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
      // K8: 把当前 run 的验证证据状态（transaction 绑定 digest + ledger 条目数）
      // 作为证据锚挂到 compact output 上——verified 洞察进入冷记忆后据此可溯源。
      const evidenceAnchor = compactionEvidenceAnchor(ctx)
      const compactOutput: CompactOutput = evidenceAnchor
        ? { ...compactResult.output, evidence: evidenceAnchor }
        : compactResult.output
      const mergeResult = ctx.thinkingStore.mergeCompressedInsights(
        ctx.stableMemoryContext ?? "",
        compactOutput,
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
          ...(evidenceAnchor ? [`Evidence: ${evidenceAnchor}`] : []),
          ...compactOutput.key_insights.map((k, i) => `${i + 1}. [insight] ${k}`),
          ...compactOutput.verified.map((v, i) => `✓ [verified] ${v}`),
          ...compactOutput.open.map((o, i) => `? [open] ${o}`),
          "</system-reminder>",
        ].join("\n")
        appendUserContext(ctx.rawMessages, compactSummary)
        ctx.stableMemoryContext = mergeResult.merged
        // K36: 写穿到 K35 稳定前缀源（options.stableMemoryContext）。round.ts
        // 的 maintenanceCtx.stableMemoryContext 是源字段的拷贝，仅更新本地字段
        // 不会被下一轮源指纹捕获——故需写穿钩子。接线后下一轮指纹漂移 → 重建
        // frozen prefix。可观测：trace + status。
        ctx.stableMemoryWriteThrough?.(mergeResult.merged)
        ctx.runTrace?.record("thinking_compaction", {
          rounds: thinkingRounds.length,
          insights: insightCount,
          merged: true,
          stablePrefixSourceUpdated: true,
          evidence: evidenceAnchor ?? null,
        })
        yield { type: "status", data: `thinking-compaction: ${thinkingRounds.length} rounds → ${insightCount} insights (appended, stable-prefix source updated → next round rebuild)` }
      }

      ctx.thinkingStore.storeCompressed({
        query: ctx.effectivePrompt,
        compactOutput,
        roundRange: `r${thinkingRounds[0]?.roundNum ?? 0}-r${thinkingRounds[thinkingRounds.length - 1]?.roundNum ?? ctx.round}`,
        filePattern: [...ctx.taskFiles].join(","),
        evidence: evidenceAnchor,
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
