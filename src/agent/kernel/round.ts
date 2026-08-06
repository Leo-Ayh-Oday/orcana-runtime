/** One Agent round (ALK PR-L7): the full round body of the legacy loop.
 *
 *  runRound() is a RunEffect phase generator: it yields stream/trace/state
 *  effects and returns a LoopDecision. It owns every per-round temporary
 *  (RoundState, provider iterator, coordinator contexts); nothing escapes
 *  the phase except effects and the final decision.
 *
 *  State commits: field-level runState changes route through
 *  RunEffect "state" (applyAgentRunStatePatch). Container mutations of
 *  objects captured by reference (rawMessages, usage, epochState, taskFiles,
 *  lifecycle) stay in place, as do mutations made by the L4–L6 coordinators
 *  and the MasterPlan controller — see kernel/types.ts commit boundary.
 */

import type { ProviderMessage, StreamEvent } from "../../provider/types"
import { isRuntimeBuiltToolDescriptor, type ToolDescriptor } from "../../tools/registry"
import { isBuiltinVerificationProducer } from "../../tools/builtins"
import { decideThinkingPlan, updateState } from "../router"
import { buildSystemPrompt } from "../prompts"
import { parseVerificationResult, formatServiceTestGuidance, type VerificationResult } from "../../verification/result"
import {
  bindVerificationToLedger,
  runBatchTypecheckAndTaskTracker,
  runRippleVerificationPhase,
  runRuntimeSelfEditGate,
} from "../verification/coordinator"
import {
  runAdaptiveCheckpoint,
  runForwardMicrocompact,
  runHistoricalMicrocompact,
  runKnowledgeDistillation,
  runKnowledgeReconcile,
  runSemanticRecall,
  runThinkingCompaction,
} from "../maintenance/coordinator"
import { revisePlan, formatTaskPlanningPrompt, formatTaskTrackerStatus, markPlanAccepted, missingTaskRequirements, snapshotTaskTracker } from "../task-tracker"
import { evaluatePlanningArtifact, formatPlanningGatePrompt } from "../planning-gate"
import { CompletionOrchestrator } from "../completion-orchestrator"
import { AgentState } from "../state-machine"
import { executeToolBatch } from "../tool-execution/batch-executor"
import { setRuntimeContextBudgetMode } from "../runtime-context"
import { getBlockingObligations } from "../../ripple/obligations"
import { currentTransactionEvidenceBinding } from "../patch-transaction"
import { buildRoundProviderRequest, cacheStableProviderTools, estimateRoundTokens } from "../round/request-builder"
import { createPreRoundChain } from "../gates/pre-round"
import { processGateOverflow } from "../gates/overflow"
import {
  classifyEpochAction,
  epochRollover,
  formatEpochBudgetWarning,
  formatEpochStatus,
  totalMessageChars,
} from "../context-epoch"
import { distillUserConstraints, extractUserTexts, formatConstraintContext } from "../memory/user-constraints"
import { appendUserContext } from "../maintenance/coordinator"
import { collectResearchEvidence, explicitRequiredFiles } from "../round/pre-loop"
import {
  createContextRequest,
  createDefaultContextProviders,
  contextSliceToMessages,
  runContextPipeline,
  stableMessageOf,
} from "../../harness/context"
import { createRoundState } from "../run/state"
import { runProviderRound } from "../provider/round-runner"
import { createProviderRoundResult, type ProviderRoundResult } from "../provider/round-result"
import { decideProviderFailureRecovery } from "../provider/failure-policy"
import { collectRecentTurns, updateStateMachine } from "../round/post-loop"
import { currentNode, planProgress } from "../master-plan"
import { activateMasterPlan, tryNodeTransition } from "./master-plan"
import { patch, stream, trace, wrapEvents } from "./effects"
import type { LoopDecision, RunEffect, RunPhaseContext } from "./types"

export function trustedVerificationFromTool(
  tool: ToolDescriptor | undefined,
  result: { success: boolean; metadata?: Record<string, unknown> },
): VerificationResult | undefined {
  if (
    !tool
    || !isRuntimeBuiltToolDescriptor(tool)
    || !isBuiltinVerificationProducer(tool.defn)
    || tool.contract?.provenance !== "local"
    || !tool.contract?.state.updates.includes("evidence")
  ) {
    return undefined
  }
  return parseVerificationResult(result.metadata?.verification)
}

function isCompletionEvidenceReport(text: string): boolean {
  return /^##\s+(Delivery Report|交付报告)\s*$/im.test(text)
    && /^##\s+(Evidence|证据)\s*$/im.test(text)
    && /^##\s+(Risk|风险)\s*$/im.test(text)
}

export async function* runRound(
  round: number,
  ctx: RunPhaseContext,
): AsyncGenerator<RunEffect, LoopDecision, unknown> {
  const {
    options,
    provider,
    model,
    tools,
    hooks,
    abortSignal,
    stagedContext,
    planning,
    execution,
    verificationState,
    budget,
    notices,
    maintenance,
    intentPolicy,
    evidenceLedger,
    triageSkillPrompts,
    planStore,
    permissionGate,
    gateTelemetry,
    errorTracker,
    taskFiles,
    rawMessages,
  } = ctx
  ctx.lifecycle.finalRound = round
  yield trace("round_started", { round })
  // All provider/tool temporaries for this iteration are owned here and become
  // unreachable on continue/break. Only explicit commits reach AgentRunState.
  const roundState = createRoundState(round)
  const thinkingDecision = decideThinkingPlan(ctx.state, execution.requestedMaxThinking ? "max" : options.thinkEffort, {
    prompt: ctx.effectivePrompt,
    intentMode: intentPolicy.mode,
    planningPhase: planning.taskTracker?.phase === "planning",
    autoMaxSignals: { consecutiveErrors: execution.consecutiveErrors, modifiedFiles: execution.modifiedFileCount },
  })
  const thinking = thinkingDecision.thinking
  const maxTok = thinkingDecision.maxTokens
  yield trace("thinking_decision", { round, ...thinkingDecision })

  const system = buildSystemPrompt()
  // ── Context Pipeline (H10): every context source is a harness provider;
  // the pipeline assembles the byte-frozen message list (plan §16). Budget
  // stays disabled here — trimming is a separate decision with its own
  // Golden Trace update (§3.5). ──
  const contextSlice = await runContextPipeline({
    providers: createDefaultContextProviders(),
    request: createContextRequest(ctx, round),
  })
  const contextMessages = contextSliceToMessages(contextSlice)
  const planStateText = contextSlice.byProvider.get("plan-state")?.content ?? ""
  const taskPlanning = planning.taskTracker?.phase === "planning"
  // ── Frozen stable prefix: computed once on round 0, reused across all rounds ──
  // (the pipeline's stable-memory provider passes it through byte-for-byte
  // from round 1 — plan §23 cache stability).
  const stableMessage = stableMessageOf(contextSlice)
  if (round === 0 && !ctx.runState.conversation.frozenStablePrefix && stableMessage) {
    yield patch({ conversation: { frozenStablePrefix: stableMessage } })
  }
  // ── Context messages: all go BEFORE rawMessages ──
  // Anthropic API requires tool_use→tool_result adjacency. Any user
  // message inserted between an assistant(tool_use) and user(tool_result)
  // is a 400 error. So volatile/planning/budget context must precede
  // rawMessages, never follow it. (pipeline output preserves this order)

  // ── Epoch check: estimate total chars and classify action ──
  const epochTotalChars = totalMessageChars(contextMessages) + totalMessageChars(rawMessages)
  const epochAction = classifyEpochAction(epochTotalChars, ctx.epochState.thresholds)
  if (epochAction !== "none") {
    yield stream({ type: "status", data: formatEpochStatus(ctx.epochState, round, epochTotalChars) })
  }

  // ── Epoch rollover (PR 4): archive volatile tail when threshold reached ──
  if (epochAction === "rollover") {
    // X1 (RC-02.5): rollover 前蒸馏被归档 user 消息中的硬约束，并入 epoch preamble（Layer 2）。
    const archivedUserTexts = extractUserTexts(rawMessages)
    const distilled = archivedUserTexts.length >= 3
      ? await distillUserConstraints(ctx.provider, ctx.modelRouter?.selectForPurpose("thinking_compaction") ?? "deepseek-v4-flash", archivedUserTexts, ctx.abortSignal)
      : null
    let planStateForRollover = planStateText
    if (distilled?.success && distilled.constraints.length > 0) {
      planStateForRollover = planStateText + "\n\n" + formatConstraintContext(distilled.constraints)
      yield stream({ type: "status", data: `user-constraints: ${distilled.constraints.length} 条约束蒸馏并入 epoch preamble` })
      yield trace("user_constraints_distilled", { count: distilled.constraints.length, archived: archivedUserTexts.length })
    }
    const rolloverResult = epochRollover(rawMessages, 3 /* keep 3 most recent turns */, planStateForRollover, ctx.epochState, round)
    if ("blocked" in rolloverResult) {
      yield stream({ type: "status", data: `epoch-rollover: blocked — ${rolloverResult.reason}` })
      // Continue without rollover; will retry next round
    } else {
      // Replace rawMessages with rolled-over version
      while (rawMessages.length > 0) rawMessages.pop()
      for (const m of rolloverResult.messages) rawMessages.push(m)
      ctx.epochState.currentEpochIndex++
      ctx.epochState.epochStartRound = round
      ctx.epochState.rolloverCount++
      ctx.epochState.totalCharsTrimmed += rolloverResult.charsTrimmed
      ctx.epochState.snapshots.push(rolloverResult.snapshot)
      yield stream({ type: "status", data: `epoch-rollover: ${rolloverResult.archivedCount} messages archived (${rolloverResult.charsTrimmed} chars), ${rawMessages.length} messages retained` })
      yield trace("epoch_rollover", {
        epochIndex: rolloverResult.snapshot.index,
        round,
        archivedCount: rolloverResult.archivedCount,
        charsTrimmed: rolloverResult.charsTrimmed,
      })
    }
  }
  if (!notices.announcedKernel) {
    yield patch({ notices: { announcedKernel: true } })
    yield stream({ type: "status", data: `context-kernel: ${ctx.contextKernel.hash} (~${ctx.contextKernel.estimatedTokens} tokens)` })
  }

  // Use session model for all rounds — model switching breaks prefix cache
  const modelName = model
  ctx.usage.proRounds++
  yield trace("model_selected", {
    round,
    requestedModel: modelName,
    route: "configured_model",
    thinkingEnabled: Boolean(thinking),
    maxTokens: maxTok,
  })

  ctx.usage.apiCalls++

  // ── Pre-round gate chain: context budget → tool disclosure → readonly/plan → ripple filter ──
  const preTokens = estimateRoundTokens(system, contextMessages, rawMessages, null, tools)
  const contextText = preTokens.providerMessages.map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n").slice(-4000) + "\n" + system
  const preRoundCtx = {
    round,
    roundInputTokens: preTokens.roundInputTokens,
    contextMax: ctx.CONTEXT_MAX,
    fullTools: tools,
    tools,
    rippleReports: verificationState.lastRippleReports,
    pendingRippleObligations: verificationState.rippleObligations,
    intentReadonly: intentPolicy.mode === "readonly",
    taskPlanning: Boolean(taskPlanning),
    contextReadinessBlocked: ctx.contextMap.contextReadinessBlocked,
    cacheStableTools: ctx.cacheStableTools,
    disclosureContextText: contextText,
    contextBudgetMode: "normal" as const,
    contextBudgetPercent: 0,
    budgetMessage: null as ProviderMessage | null,
    announcedDegraded: notices.announcedContextDegraded,
    rippleBlockActive: false,
    contextReadinessBlockActive: false,
    tokensSaved: 0,
    activeTools: tools,
  }
  const preRoundChain = createPreRoundChain()
  const preRoundResult = preRoundChain.evaluateSync(preRoundCtx, gateTelemetry)

  setRuntimeContextBudgetMode(preRoundCtx.contextBudgetMode)
  const budgetContext = preRoundCtx.budgetMessage
  const disclosedTools = ctx.cacheStableTools ? tools : preRoundCtx.activeTools
  const { roundInputTokens, providerMessages } = estimateRoundTokens(
    system, contextMessages, rawMessages, budgetContext, disclosedTools,
  )
  const estimatedRoundInputTokens = roundInputTokens
  ctx.usage.estimatedInputTokens += roundInputTokens
  yield patch({ budget: { contextInput: budget.contextInput + roundInputTokens } })

  if (!preRoundResult.pass) {
    // Context budget block — hard exit
    yield stream({ type: "status", data: `context-budget: block ${preRoundCtx.contextBudgetPercent}%` })
    yield trace("gate_decision", { gate: "policy:context_budget", decision: "block", percent: preRoundCtx.contextBudgetPercent })
    yield stream({ type: "text", data: preRoundResult.message ?? "Context budget exceeded." })
    return { kind: "break", reason: "context_budget" }
  }
  if ((preRoundCtx.contextBudgetMode as string) === "degraded" && !notices.announcedContextDegraded) {
    yield patch({ notices: { announcedContextDegraded: true } })
    yield stream({ type: "status", data: `context-budget: degraded ${preRoundCtx.contextBudgetPercent}%; finish current stage only` })
  }

  // ── PR 4: Epoch budget warning on force-compress (one-shot) ──
  if (epochAction === "forceCompress" && !notices.announcedEpochForceCompress) {
    yield patch({ notices: { announcedEpochForceCompress: true } })
    const epochWarning = formatEpochBudgetWarning(
      Math.round((epochTotalChars / ctx.epochState.thresholds.forceCompressChars) * 100),
      ctx.epochState.thresholds,
    )
    // Inject as a user message into rawMessages to warn the model
    rawMessages.push({ role: "user", content: epochWarning })
    yield stream({ type: "status", data: `epoch-budget: force-compress — ${Math.round(epochTotalChars / 1000)}k chars` })
  }

  // Apply ripple block side effects
  yield patch({ execution: { rippleBlockActive: preRoundCtx.rippleBlockActive } })
  if (execution.rippleBlockActive) {
    for (const report of verificationState.lastRippleReports) ctx.sandbox.blockFileWrite(report.targetFile)
  }

  const activeTools = ctx.cacheStableTools && !preRoundCtx.contextReadinessBlockActive
    ? cacheStableProviderTools(tools)
    : preRoundCtx.activeTools

  if (!ctx.cacheStableTools && preRoundCtx.tokensSaved > 0) {
    yield stream({ type: "status", data: `tools: ${activeTools.length}/${tools.length} (↓${preRoundCtx.tokensSaved} tokens)` })
  }
  if (round === 0 && intentPolicy.mode === "readonly") {
    yield stream({ type: "status", data: `intent-gate: readonly (${intentPolicy.reason})` })
  }
  if (round === 0 && planning.taskTracker) {
    yield stream({ type: "status", data: "任务追踪: 已识别为长任务，先规划再执行" })
  }
  if (planning.taskTracker) {
    const status = formatTaskTrackerStatus(planning.taskTracker)
    if (status) yield stream({ type: "status", data: status })
    yield stream({ type: "task_progress", data: snapshotTaskTracker(planning.taskTracker) })
  }
  if (preRoundCtx.taskPlanning && round > 0) {
    yield stream({ type: "status", data: "任务追踪: 规划阶段只输出计划" })
  }
  if (execution.rippleBlockActive) {
    yield stream({ type: "status", data: `涟漪阻止: 写工具已禁用 (${verificationState.rippleObligations.length} 个调用方未更新)` })
    yield trace("gate_decision", { gate: "ripple_block", decision: "block", pending: verificationState.rippleObligations.length })
  }
  const roundRequest = buildRoundProviderRequest({
    modelName,
    system,
    providerMessages,
    tools: activeTools,
    cacheTracker: ctx.cacheTracker,
    thinkingTokenTotal: budget.thinkingTokens,
    contextInputTotal: budget.contextInput,
    contextOutputTotal: budget.contextOutput,
    contextMax: ctx.CONTEXT_MAX,
    round,
    contextUsagePercent: preRoundCtx.contextBudgetPercent,
  })
  const { providerToolSchemas, cacheAnatomy, cacheShape, cacheStatus, estimatedUsageEvent } = roundRequest
  if (cacheStatus === "hit") { ctx.usage.cacheHits++ } else { ctx.usage.cacheMisses++ }
  yield trace("cache_prefix_shape", {
    round,
    cacheStatus,
    prefixHash: cacheShape.prefixHash,
    firstChangedSection: cacheShape.firstChangedSection,
    sections: cacheShape.sections,
  })
  yield trace("token_usage", estimatedUsageEvent)
  yield stream({ type: "token_usage", data: estimatedUsageEvent })
  yield stream({ type: "status", data: thinking ? thinkingDecision.visibleStatus : "working" })

  const shouldBufferCompletionText = planning.taskTracker?.phase === "building"
    || planning.taskTracker?.phase === "complete"
    || execution.taskHadWrite
    || execution.toolErrors > 0
  const bufferReadonlyText = intentPolicy.mode === "readonly" || shouldBufferCompletionText
  const providerRoundIterator = runProviderRound({
    provider,
    request: {
      model: modelName,
      purpose: "agent_main",
      system,
      messages: providerMessages,
      tools: providerToolSchemas,
      thinking,
      maxTokens: maxTok,
    },
    abortSignal,
    bufferText: bufferReadonlyText,
  })
  let providerRoundResult: ProviderRoundResult | undefined
  try {
    while (true) {
      const next = await providerRoundIterator.next()
      if (next.done) {
        providerRoundResult = next.value
        break
      }
      const event = next.value
      if (event.type === "status") {
        yield trace("provider_status", { round, status: event.data })
      }
      yield stream(event)
    }
  } finally {
    if (!providerRoundResult) {
      await providerRoundIterator.return(createProviderRoundResult())
    }
  }

  providerRoundResult ??= createProviderRoundResult()
  roundState.textChunks = providerRoundResult.textChunks
  roundState.finalText = providerRoundResult.finalText
  roundState.thinkingBlocks = providerRoundResult.thinkingBlocks
  roundState.toolCalls = providerRoundResult.toolCalls
  roundState.providerUsage = providerRoundResult.usage
  roundState.providerFailure = providerRoundResult.failure
  roundState.bufferedTextEmitted = providerRoundResult.bufferedTextEmitted

  if (abortSignal?.aborted) {
    yield trace("agent_loop_aborted", { round, reason: String(abortSignal.reason ?? "aborted") })
    return { kind: "return", reason: "aborted" }
  }

  const roundMs = Date.now() - roundState.startedAt

  const textChunks = roundState.textChunks
  const completedToolCalls = roundState.toolCalls
  const finalText = roundState.finalText
  yield trace("round_output", {
    round,
    finalTextChars: finalText.length,
    textChunkCount: textChunks.length,
    completedToolCalls: completedToolCalls.length,
    streamError: roundState.providerFailure?.message,
    bufferReadonlyText,
  })
  const providerRoundInputTokens = roundState.providerUsage
    ? (roundState.providerUsage.cacheReadInputTokens ?? 0) + (roundState.providerUsage.cacheMissInputTokens ?? roundState.providerUsage.inputTokens ?? 0)
    : undefined
  if (typeof providerRoundInputTokens === "number" && providerRoundInputTokens > 0) {
    yield patch({ budget: { contextInput: budget.contextInput + providerRoundInputTokens - estimatedRoundInputTokens } })
  }

  const estimatedOutputTokens = Math.round(finalText.length / 3 + completedToolCalls.reduce((s, tc) => s + JSON.stringify(tc.input).length / 3, 0))
  yield patch({ budget: { contextOutput: budget.contextOutput + (roundState.providerUsage?.outputTokens ?? estimatedOutputTokens) } })
  const displayedCacheHitRate = roundState.providerUsage?.cacheHitRate ?? ctx.cacheTracker.hitRate
  const finalUsageEvent = {
      requestedModel: modelName,
      actualModel: roundState.providerUsage?.actualModel,
      inputTokens: budget.contextInput,
      outputTokens: budget.contextOutput,
      contextMax: ctx.CONTEXT_MAX,
      round,
      roundMs,
      cacheHitRate: displayedCacheHitRate,
      cacheStatus,
      cacheSource: roundState.providerUsage ? "provider" : "estimate",
      cacheReadInputTokens: roundState.providerUsage?.cacheReadInputTokens,
      cacheMissInputTokens: roundState.providerUsage?.cacheMissInputTokens,
      cacheCreationInputTokens: roundState.providerUsage?.cacheCreationInputTokens,
      cachePrefixShape: { firstChangedSection: cacheShape.firstChangedSection, sections: cacheShape.sections },
      contextUsagePercent: preRoundCtx.contextBudgetPercent,
      cacheAnatomy,
  }
  yield trace("token_usage", finalUsageEvent)
  yield stream({
    type: "token_usage",
    data: finalUsageEvent,
  })

  if (roundState.providerFailure) {
    const recovery = decideProviderFailureRecovery({
      failure: roundState.providerFailure,
      round,
      maxRounds: ctx.maxRounds,
      finalText,
      taskTracker: planning.taskTracker,
      changedFiles: [...taskFiles],
    })
    for (const message of recovery.messages) rawMessages.push(message)
    if (recovery.emitError) {
      yield stream({ type: "error", data: roundState.providerFailure.message })
    }
    yield stream({ type: "status", data: recovery.status })
    if (recovery.text) yield stream({ type: "text", data: recovery.text })
    yield trace("gate_decision", recovery.trace)
    if (recovery.action === "continue") return { kind: "continue" }
    return { kind: "break", reason: "provider_failure" }
  }

  if (completedToolCalls.length === 0 && finalText) {
    // ── Completion Orchestrator: unified final gate evaluation (PR-3.1) ──
    const orchestrator = new CompletionOrchestrator()
    const orchResult = await orchestrator.evaluate({
      round,
      finalText,
      intentPolicy,
      taskTracker: planning.taskTracker,
      pendingRippleObligations: verificationState.rippleObligations,
      verificationResults: verificationState.lastResults,
      changedFiles: [...taskFiles],
      taskHadWrite: execution.taskHadWrite,
      taskToolErrors: execution.toolErrors,
      taskModifiedFiles: execution.modifiedFileCount,
      lastRippleReports: verificationState.lastRippleReports,
      planApproved: planning.planApproved,
      planningRejections: planning.planningRejections,
      maxRounds: ctx.maxRounds,
      priorTools: execution.lastToolNames,
      priorFiles: taskFiles,
      confidenceEvaluator: ctx.confidenceEvaluator,
      evidenceLedger,
      evidenceBinding: currentTransactionEvidenceBinding(),
      testimonyLedger: ctx.testimonyLedger,
      flashJudge: ctx.flashJudge,
      masterPlan: planStore.current,
      autoApprovePlan: options.autoApprovePlan ?? false,
      language: ctx.language,
      runTrace: ctx.runTrace,
      gateTelemetry,
      recentTurns: collectRecentTurns(rawMessages, 6),
      approvedPlanText: options.planText,
    })

    // Apply orchestrator side effects
    for (const msg of orchResult.injectMessages) {
      rawMessages.push(msg as ProviderMessage)
    }
    for (const s of orchResult.statusMessages) {
      yield stream({ type: "status", data: s })
    }
    for (const t of orchResult.yieldTexts) {
      // The model's finalText is either already streamed or emitted below for
      // buffered runs. Emitting the accepted evidence wrapper as assistant
      // text duplicates that response; the TUI then mistakes its four-line
      // compact preview for the full answer and hides the real trailing text.
      if (isCompletionEvidenceReport(t)) continue
      yield stream({ type: "text", data: t })
    }
    for (const ev of orchResult.traceEvents) {
      yield trace("gate_decision", ev)
    }
    if (orchResult.planningRejections !== undefined) {
      yield patch({ planning: { planningRejections: orchResult.planningRejections } })
    }

    // Handle plan auto-approve → activate master plan
    if (orchResult.activateMasterPlan) {
      const { planText, goal, forcePacket } = orchResult.activateMasterPlan
      if (activateMasterPlan(ctx, planText, goal, forcePacket)) {
        yield stream({ type: "status", data: `master-plan: ${planProgressOf(ctx)} nodes` })
      }
    }

    switch (orchResult.decision) {
      case "plan_ready":
        if (orchResult.breakEvent) {
          yield stream(orchResult.breakEvent as { type: "plan_ready"; data: unknown })
        }
        return { kind: "break", reason: "orchestrator_plan_ready" }
      case "continue":
        return { kind: "continue" }
      case "break_blocked":
        return { kind: "break", reason: "orchestrator_blocked" }
      case "done": {
        // Try master plan node transition before final delivery
        if (orchResult.tryNodeTransition && planStore.current && tryNodeTransition(ctx)) {
          // RC-13 E2: 节点切换前 flush 缓冲文本——bufferReadonlyText 模式下的
          // 最终答复不得在切换中丢失。
          if (bufferReadonlyText && !roundState.bufferedTextEmitted) {
            yield stream({ type: "text", data: finalText })
            roundState.bufferedTextEmitted = true
          }
          yield stream({ type: "status", data: `master-plan: ${planProgressOf(ctx)} → next node activated` })
          yield trace("gate_decision", { gate: "master_plan", decision: "next_node", progress: planProgressOf(ctx) })
          return { kind: "continue" }
        }
        if (planStore.current) {
          yield stream({ type: "status", data: "master-plan: all nodes complete" })
          yield trace("gate_decision", { gate: "master_plan", decision: "plan_complete" })
        }
        if (bufferReadonlyText && !roundState.bufferedTextEmitted) {
          yield stream({ type: "text", data: finalText })
        }
        return { kind: "break", reason: "orchestrator_done" }
      }
    }
  }
  if (completedToolCalls.length === 0) {
    yield stream({ type: "status", data: "empty-round: no tool calls or final text" })
    return { kind: "break", reason: "empty_round" }
  }

  const assistantContent: Array<Record<string, unknown>> = []
  for (const tb of roundState.thinkingBlocks) assistantContent.push({ type: "thinking", thinking: tb.thinking, signature: tb.signature })
  if (finalText) assistantContent.push({ type: "text", text: finalText })
  for (const tc of completedToolCalls) assistantContent.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input })
  rawMessages.push({ role: "assistant", content: assistantContent })

  // ── Persist thinking chain ──
  if (ctx.thinkingStore && roundState.thinkingBlocks.length > 0) {
    yield patch({ budget: { thinkingTokens: budget.thinkingTokens + roundState.thinkingBlocks.reduce((sum, tb) => sum + Math.round(tb.thinking.length / 3), 0) } })
    ctx.thinkingStore.storeThinking({
      query: ctx.effectivePrompt,
      thinkingBlocks: roundState.thinkingBlocks,
      roundNum: round,
      filePattern: [...taskFiles].join(","),
      tags: [
        ...(ctx.state.hadError ? ["error"] : []),
        intentPolicy.mode,
        `round-${round}`,
      ],
      toolContext: completedToolCalls.map(tc => tc.name),
    })
  }

  // ── Execute tools + self-learn tracking (L4: ToolBatchExecutor) ──
  const toolNames = roundState.toolNames
  const filePaths = roundState.filePaths
  const resultsContent = roundState.toolResults
  const learnPrompts = roundState.learnPrompts
  const modifiedFilesThisRound = roundState.modifiedFiles
  const rippleReportsThisRound = roundState.rippleReports
  const verificationResultsThisRound = roundState.verificationResults

  const batchResult = yield* wrapEvents(executeToolBatch({
    round,
    completedToolCalls,
    tools,
    hooks,
    abortSignal,
    runTrace: ctx.runTrace,
    thinkingStore: ctx.thinkingStore,
    roundState,
    planning,
    execution,
    verificationState,
    notices,
    intentPolicy,
    permissionGate,
    permissionMode: ctx.pmode,
    preRoundCtx,
    contextReadinessBlocked: ctx.contextMap.contextReadinessBlocked,
    contextReadinessBlockers: ctx.contextMap.contextReadinessBlockers,
    finalText,
    toolLedger: ctx.toolLedger,
    gateTelemetry,
    errorTracker,
    stagedContext,
    prompt: ctx.prompt,
    resultsContent,
    trustedVerification: trustedVerificationFromTool,
    // H9: route tool executions through the CapabilityExecutor (same registry
    // the Node Runtime will use) and stamp run-scoped artifact bindings.
    capabilityRegistry: ctx.capabilityRegistry,
    artifactStore: ctx.artifactStore,
    runId: ctx.runId,
  }))
  if (batchResult.aborted) return { kind: "return", reason: "tool_batch_aborted" }

  // L5: VerificationCoordinator context — shared across the verification phase.
  const verificationCtx = {
    round,
    intentPolicy,
    effectivePrompt: ctx.effectivePrompt,
    options,
    planning,
    execution,
    verificationState,
    roundState,
    evidenceLedger,
    modifiedFilesThisRound,
    rippleReportsThisRound,
    verificationResultsThisRound,
    toolNames,
    rawMessages,
    resultsContent,
    runTrace: ctx.runTrace,
    planStore,
    artifactStore: ctx.artifactStore,
    runId: ctx.runId,
    maxRounds: ctx.maxRounds,
  }
  // Bind structured verification to the canonical ledger as soon as tool execution ends.
  await bindVerificationToLedger(verificationCtx)

  // L6: MaintenanceCoordinator context — shared across low-frequency housekeeping.
  const maintenanceCtx = {
    round,
    epochAction,
    provider,
    modelRouter: ctx.modelRouter,
    knowledgeBase: ctx.knowledgeBase,
    abortSignal,
    thinkingStore: ctx.thinkingStore,
    stableMemoryContext: options.stableMemoryContext,
    effectivePrompt: ctx.effectivePrompt,
    routerRoundNum: ctx.state.roundNum,
    execution,
    verificationState,
    runState: ctx.runState,
    planning,
    maintenance,
    budget,
    planStore,
    taskFiles,
    rawMessages,
    resultsContent,
    completedToolCalls,
    learnPrompts,
    preRoundCtx,
    runTrace: ctx.runTrace,
  }

  // L6: forward microcompact (before history push)
  yield* wrapEvents(runForwardMicrocompact(maintenanceCtx))

  let postToolRequiredFilesPrompt = ""
  let postToolPlanningPrompt = ""
  const ripplePhase = yield* wrapEvents(runRippleVerificationPhase(verificationCtx))
  postToolRequiredFilesPrompt = ripplePhase.postToolRequiredFilesPrompt

  // ── Gate overflow: track cumulative blocks, force strategy switch at 3, BLOCKED at 5 ──
  ctx.sandbox.clearBlockedFiles()

  const overflowResult = processGateOverflow({
    round,
    rippleBlockActive: execution.rippleBlockActive,
    pendingRippleObligationsLength: getBlockingObligations(verificationState.rippleObligations).length,
    postToolPlanningPrompt,
    postToolRequiredFilesPrompt,
    gateBlockCounts: ctx.gateBlockCounts,
  })
  for (const msg of overflowResult.deferredMessages) ctx.deferredGateMessages.push(msg)
  for (const ev of overflowResult.statusEvents) yield stream({ type: "status", data: ev })

  if (overflowResult.blocked) {
    const reason = `${overflowResult.blockedGate} 累积阻断 ${overflowResult.blockedCount} 次，请求人工介入。`
    ctx.sm.transition(AgentState.BLOCKED, reason)
    ctx.lifecycle.stopReason = "blocked"
    yield stream({ type: "status", data: `gate-overflow: ${overflowResult.blockedGate} blocked ${overflowResult.blockedCount} times — BLOCKED` })
    yield trace("agent_loop_blocked", { reason, gate: overflowResult.blockedGate, blockCount: overflowResult.blockedCount })
    return { kind: "return", reason: "gate_overflow" }
  }

  // ── Revise plan: stuck detection → push back to planning ──
  if (
    planning.taskTracker &&
    planning.taskTracker.phase === "building" &&
    completedToolCalls.length === 0 &&
    modifiedFilesThisRound.size === 0 &&
    verificationResultsThisRound.length === 0 &&
    (execution.consecutiveErrors >= 3 || !planning.taskTracker.steps.some(s => s.status === "done"))
  ) {
    // Only use singleton revisePlan when MasterPlan is not active.
    // MasterPlan-level revisePlan (with frozen nodes) is deferred to PR 2.
    if (!planStore.current) {
    const reason = execution.consecutiveErrors >= 3
      ? `连续 ${execution.consecutiveErrors} 次工具错误`
      : "步骤未推进，当前方案可能有问题"
    const reviseMsg = revisePlan(planning.taskTracker, reason)
    ctx.deferredGateMessages.push(reviseMsg)
    yield stream({ type: "status", data: `revise-plan: ${reason}` })
    yield trace("gate_decision", { gate: "revise_plan", decision: "replan", reason })
    } // if (!masterPlan)
  }

  if (planning.taskTracker?.phase === "planning" && finalText.trim()) {
    // User already confirmed → skip gate, accept directly
    if (planning.planApproved) {
      markPlanAccepted(planning.taskTracker)
      if ((options.planText ?? planning.lastPlanText) && activateMasterPlan(ctx, options.planText ?? planning.lastPlanText, planning.taskTracker.goal)) {
        yield stream({ type: "status", data: `master-plan: ${planProgressOf(ctx)} nodes` })
      }
      yield stream({ type: "status", data: "任务追踪: 用户已确认规划，进入执行阶段" })
      yield patch({ planning: { planApproved: false } })
    } else {
      const planningGate = evaluatePlanningArtifact(finalText, planning.taskTracker)
      if (planningGate.ok) {
        markPlanAccepted(planning.taskTracker)
        if (activateMasterPlan(ctx, finalText, planning.taskTracker.goal)) {
          yield stream({ type: "status", data: `master-plan: ${planProgressOf(ctx)} nodes` })
        }
        yield stream({ type: "status", data: "任务追踪: 已读取计划，进入执行阶段" })
        yield trace("gate_decision", {
          gate: "planning",
          decision: "accepted",
          score: planningGate.score,
          signals: planningGate.signals,
        })
      } else if (round + 1 < ctx.maxRounds) {
        postToolPlanningPrompt = formatPlanningGatePrompt(planningGate, planning.taskTracker)
        yield stream({ type: "status", data: `planning-gate: revise plan (${planningGate.missing.length} missing)` })
        yield trace("gate_decision", {
          gate: "planning",
          decision: "revise",
          missing: planningGate.missing,
          score: planningGate.score,
        })
      }
    }
  }

  // L5: batch typecheck + TaskTracker verification projection + lastResults
  yield* wrapEvents(runBatchTypecheckAndTaskTracker(verificationCtx))

  // ── Inject gate overflow / revisePlan messages BEFORE tool results ──
  // Must go as CONTENT BLOCKS in the same user message as tool_results,
  // NOT as separate user messages (breaks Anthropic format: tool_use→tool_result adjacency).
  if (ctx.deferredGateMessages.length > 0) {
    for (const msg of ctx.deferredGateMessages) {
      resultsContent.unshift({ type: "text", text: msg + "\n" })
    }
    ctx.deferredGateMessages.length = 0
  }

  // Inject self-learn prompts AFTER tool results (Anthropic format: user message after tool_use)
  if (learnPrompts.length > 0) {
    const learnMsg = "## 自我学习建议\n\n" + learnPrompts.join("\n")
    const lastResult = resultsContent[resultsContent.length - 1]
    if (lastResult) {
      lastResult.content = String(lastResult.content) + "\n" + learnMsg
    }
  }

  if (postToolRequiredFilesPrompt) {
    const lastResult = resultsContent[resultsContent.length - 1]
    if (lastResult) {
      lastResult.content = String(lastResult.content) + "\n" + postToolRequiredFilesPrompt
    }
  }

  // Safety net: ensure every tool_use has a tool_result (prevents 400)
  for (const tc of completedToolCalls) {
    if (!resultsContent.some(r => typeof r === "object" && r !== null && !Array.isArray(r) && r.type === "tool_result" && r.tool_use_id === tc.id)) {
      resultsContent.push({ type: "tool_result", tool_use_id: tc.id, content: "(skipped)", is_error: true })
    }
  }
  rawMessages.push({ role: "user", content: resultsContent })

  // L6: retrospective historical microcompact
  yield* wrapEvents(runHistoricalMicrocompact(maintenanceCtx))

  // ── State machine transition (after tool results, before next round) ──
  updateStateMachine(ctx.sm, {
    roundHadToolError: roundState.hadToolError,
    hadSearchTool: toolNames.some(t => /read_file|web_search|find_symbol|find_references|project_structure|glob|grep/.test(t)),
    hadWriteTool: toolNames.some(t => /write_file|edit_file|edit_fim/.test(t)),
    hadVerifyTool: toolNames.some(t => t === "shell" || t === "typescript"),
    isDone: round + 1 >= ctx.maxRounds || verificationState.lastTypecheck?.passed === true || (verificationState.lastResults?.some(r => r.passed) ?? false),
    pendingRippleCount: verificationState.rippleObligations.length,
  })
  // Reset one-shot thinking upgrade
  if (execution.requestedMaxThinking) yield patch({ execution: { requestedMaxThinking: false } })

  // L6: one-shot thinking compaction
  yield* wrapEvents(runThinkingCompaction(maintenanceCtx))

  // L6: semantic recall (L3 volatile historical context)
  yield* wrapEvents(runSemanticRecall(maintenanceCtx))
  updateState(ctx.state, toolNames, filePaths, Boolean(roundState.providerFailure) || roundState.hadToolError)
  yield patch({ execution: { lastToolNames: [...toolNames] } })
  if (postToolPlanningPrompt) {
    // RC-13 E3: 合并进相邻 user 消息，避免连续 user。
    appendUserContext(rawMessages, postToolPlanningPrompt)
    return { kind: "continue" }
  }

  // L5: runtime self-edit gate — moved into the VerificationCoordinator.
  const selfEditResult = yield* wrapEvents(runRuntimeSelfEditGate(verificationCtx))
  if (selfEditResult.action === "break") return { kind: "break", reason: "self_edit" }
  if (selfEditResult.action === "continue") return { kind: "continue" }

  if (roundState.serviceTestGuidanceNeeded) {
    rawMessages.push({ role: "user", content: formatServiceTestGuidance() })
    yield stream({ type: "status", data: "服务型测试: 要求改为测试内启动并关闭服务" })
    yield trace("gate_decision", { gate: "service_test", decision: "repair_guidance" })
  }

  if (roundState.narrowEditEvidenceBlocked) {
    return { kind: "continue" }
  }

  const missingLongTask = missingTaskRequirements(planning.taskTracker)
  if (planning.taskTracker?.phase === "planning" && missingLongTask.length > 0 && round + 1 < ctx.maxRounds) {
    rawMessages.push({ role: "user", content: formatTaskPlanningPrompt(planning.taskTracker, round + 1) })
    yield stream({ type: "status", data: "任务追踪: 等待计划文本，下一轮不允许调用工具" })
    yield trace("gate_decision", { gate: "semantic:task_tracker", decision: "plan_required", missing: missingLongTask })
    return { kind: "continue" }
  }
  if (planning.taskTracker && missingLongTask.length > 0) {
    rawMessages.push({ role: "user", content: [
      "## 任务追踪未完成",
      "继续执行。尚未完成：",
      ...missingLongTask.slice(0, 12).map(item => `- ${item}`),
      "",
      "下一轮必须处理第一个未完成项，并在完成后运行验证。",
    ].join("\n") })
    yield stream({ type: "status", data: `任务追踪: 阻止结束，剩余 ${missingLongTask.length} 项` })
    yield trace("gate_decision", { gate: "semantic:task_tracker", decision: "continue", missing: missingLongTask })
  } else if (roundState.completionGateText) {
    yield stream({ type: "status", data: "completion-gate: verified write; stopping without extra provider round" })
    yield stream({ type: "text", data: roundState.completionGateText })
    yield trace("gate_decision", { gate: "completion", decision: "verified_write_stop" })
    return { kind: "break", reason: "verified_write" }
  }

  if (stagedContext && completedToolCalls.length && finalText) {
    stagedContext.addSummary(finalText.slice(0, 120))
    stagedContext.advance()
  }

  // L6: adaptive density checkpoint
  yield* wrapEvents(runAdaptiveCheckpoint(maintenanceCtx))

  // L6: best-effort web_search -> knowledge base distillation
  runKnowledgeDistillation(maintenanceCtx)

  // L6: periodic memory reconcile (prune + FTS5 rebuild)
  yield* wrapEvents(runKnowledgeReconcile(maintenanceCtx))

  if (round + 1 >= ctx.maxRounds) ctx.lifecycle.reachedRoundBudget = true
  return { kind: "continue" }
}

// ── Local helper ──

function planProgressOf(ctx: RunPhaseContext): string {
  const plan = ctx.planStore.current
  return plan ? planProgress(plan) : ""
}
