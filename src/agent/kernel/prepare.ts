/** Pre-round gates (ALK PR-L7): clarification → research → context map → plan approval.
 *
 *  Ports the pre-round section of loop.ts. The phase yields RunEffect (the
 *  clarification gate streams provider events, research/context-map gates emit
 *  status + trace) and returns the LoopDecision: "continue" into the round
 *  loop, or "return: clarification" after the clarification pause.
 */

import { buildModelClarificationCall, evaluateClarificationNeed, formatModelClarificationFailure, parseModelClarification } from "../clarification"
import { streamProviderRoundEvents } from "../provider/round-runner"
import { shouldRunResearch } from "../research-router"
import { buildResearchEvidenceContext, buildResearchInsufficientEvidenceMessage } from "../research-answer"
import { collectResearchEvidence, explicitRequiredFiles } from "../round/pre-loop"
import { buildContextMap, contextEvidenceForMap, evaluateContextReadiness, formatContextMapSummary, selectContextMapTaskLevel, type ContextMapTaskLevel } from "../../context/context-map"
import { createContextDebts, openContextDebtCount } from "../../context/context-debt"
import { getWorkspaceIoAuthority } from "../../runtime/execution-context"
import { markPlanAccepted } from "../task-tracker"
import { planProgress } from "../master-plan"
import { activateMasterPlan } from "./master-plan"
import { patch, stream, trace } from "./effects"
import type { LoopDecision, RunEffect, RunPhaseContext } from "./types"

export async function* prepareRun(ctx: RunPhaseContext): AsyncGenerator<RunEffect, LoopDecision, unknown> {
  // ── Clarification gate: ask the user when the task is ambiguous ──
  const clarification = evaluateClarificationNeed({
    prompt: ctx.effectivePrompt,
    tracker: ctx.planning.taskTracker,
    history: ctx.options.conversationHistory,
  })
  if (clarification.required) {
    yield stream({ type: "status", data: "clarification-gate: thinking before planning" })
    let modelText = ""
    let modelFailed = !ctx.planning.taskTracker
    let modelInputTokens = 0
    if (ctx.planning.taskTracker) {
      const clarificationCall = buildModelClarificationCall({
        provider: ctx.provider,
        model: ctx.model,
        prompt: ctx.effectivePrompt,
        tracker: ctx.planning.taskTracker,
        result: clarification,
        language: ctx.language,
      })
      modelInputTokens = Math.max(1, Math.round((clarificationCall.system.length + JSON.stringify(clarificationCall.messages).length) / 3))
      try {
        for await (const event of streamProviderRoundEvents({
          provider: ctx.provider,
          request: clarificationCall,
          abortSignal: ctx.abortSignal,
        })) {
          if (event.type === "text") {
            const chunk = String(event.data ?? "")
            modelText += chunk
            yield stream({
              type: "token_usage",
              data: {
                inputTokens: modelInputTokens,
                outputTokens: Math.max(1, Math.round(modelText.length / 3)),
                contextMax: 1_048_576,
                cacheSource: "estimate",
              },
            })
          } else if (event.type === "status" || event.type === "error" || event.type === "token_usage") {
            yield stream(event)
          }
        }
      } catch {
        modelFailed = true
      }
    }

    const structuredClarification = !modelFailed
      ? parseModelClarification(modelText, clarification.originalPrompt ?? ctx.effectivePrompt)
      : null
    if (structuredClarification) {
      yield stream({ type: "clarification_ready", data: structuredClarification })
    } else {
      yield stream({ type: "error", data: formatModelClarificationFailure() })
    }
    yield trace("gate_decision", {
      gate: "clarification",
      decision: "ask",
      reason: clarification.reason,
      source: structuredClarification ? "model_structured" : "model_failed",
    })
    return { kind: "return", reason: "clarification" }
  }

  // ── Research router: web research for research-answer tasks ──
  if (shouldRunResearch(ctx.researchDecision)) {
    yield stream({ type: "status", data: `research-router: ${ctx.researchDecision.reason}` })
    yield trace("gate_decision", {
      gate: "research_router",
      decision: "research_answer",
      reason: ctx.researchDecision.reason,
      questions: ctx.researchDecision.researchQuestions,
    })
    const evidence = await collectResearchEvidence({
      tools: ctx.tools,
      queries: ctx.researchDecision.researchQuestions,
      hooks: ctx.hooks,
    })
    const successCount = evidence.filter(item => item.success).length
    yield stream({ type: "status", data: `research-router: evidence ${successCount}/${evidence.length}` })
    yield patch({
      research: {
        evidence,
        context: successCount > 0
          ? buildResearchEvidenceContext(ctx.researchDecision, evidence)
          : { role: "user", content: buildResearchInsufficientEvidenceMessage(ctx.researchDecision, evidence) },
      },
    })
  } else if (ctx.researchDecision.mode === "deep_discussion") {
    yield trace("gate_decision", {
      gate: "research_router",
      decision: "deep_discussion",
      reason: ctx.researchDecision.reason,
      needWeb: ctx.researchDecision.needWeb,
    })
  }

  // ── Context Map: acquire project map for long/high-risk tasks ──
  const envContextMapPolicy = process.env.ORCANA_CONTEXT_MAP
  const contextMapPolicy: "off" | "auto" | "always" = ctx.options.contextMapPolicy ?? (
    envContextMapPolicy === "off" || envContextMapPolicy === "always"
      ? envContextMapPolicy
      : "auto"
  )
  const explicitFilesForContext = explicitRequiredFiles(ctx.effectivePrompt)
  const contextMapLevel: ContextMapTaskLevel = selectContextMapTaskLevel({
    userRequest: ctx.effectivePrompt,
    risk: ctx.triageResult?.riskLevel === "high" ? "high" : undefined,
    touchedFiles: explicitFilesForContext.length,
  })
  const shouldBuildContextMap = contextMapPolicy === "always" ||
    (contextMapPolicy === "auto" && ctx.intentPolicy.mode !== "readonly" && (
      contextMapLevel === "long" ||
      contextMapLevel === "high_risk" ||
      explicitFilesForContext.length > 0
    ))
  if (shouldBuildContextMap) {
    // IC01-R3: production 路径显式注入 WorkspaceIoAuthority —— 无权威时
    // ContextMapReadSession fail closed（所有读取拒绝，绝不隐式放行）。
    const runtimeContextMap = buildContextMap(ctx.options.projectRoot ?? process.cwd(), {
      taskId: "runtime-task",
      userRequest: ctx.effectivePrompt,
      keywords: explicitFilesForContext,
    }, { workspace: getWorkspaceIoAuthority() })
    const readiness = evaluateContextReadiness(runtimeContextMap, contextMapLevel)
    const blockers = readiness.blockers
    // IC05 P2: readiness blockers 降级为 ContextDebt（obligation）—— 写工具
    // 保持可用，DONE 前需偿还。contextReadinessBlocked 恒 false（legacy
    // field 保留兼容，不再拥有 hard authority）。
    const debts = createContextDebts({
      hasLocateResult: readiness.hasLocateResult,
      hasSourceUnderstanding: readiness.hasSourceUnderstanding,
      hasProjectConstitution: readiness.hasProjectConstitution,
      hasVerificationPlan: readiness.hasVerificationPlan,
      confidence: readiness.confidence,
      highRisk: contextMapLevel === "high_risk",
      // TaskTracker requiredVerificationKinds 是 Runtime-owned verification
      // plan evidence。
      hasRuntimeVerificationPlan: Boolean(ctx.planning.taskTracker?.requiredVerificationKinds?.length),
    })
    ctx.contextMap.runtimeContextMap = runtimeContextMap
    ctx.contextMap.contextMapContext = [
      "## Context Map",
      `level: ${contextMapLevel}`,
      formatContextMapSummary(runtimeContextMap),
      `readiness: ${blockers.length ? blockers.join(" | ") : "ready"}`,
      blockers.length ? `ContextDebt open: ${debts.filter(d => d.status === "open").map(d => d.kind).join(", ")} (advisory — writes allowed)` : "",
    ].filter(Boolean).join("\n")
    ctx.contextMap.contextReadinessBlockers = blockers
    ctx.contextMap.contextReadinessBlocked = false
    ctx.contextMap.contextDebts = debts
    ctx.contextMap.planContextAttachment = {
      contextMapId: runtimeContextMap.id,
      requiredContextEvidence: contextEvidenceForMap(runtimeContextMap),
    }
    yield stream({ type: "status", data: `context-map: ${runtimeContextMap.id} ${contextMapLevel} ${debts.length ? "advisory" : "ready"} (${openContextDebtCount(debts)} debts)` })
    yield trace("gate_decision", {
      gate: "context_readiness",
      authority: "advisory",
      decision: debts.length ? "debt_created" : "pass",
      openDebtCount: openContextDebtCount(debts),
      level: contextMapLevel,
      blockers,
      contextMapId: runtimeContextMap.id,
    })
  }

  // ── Plan approval flow: user approved the plan via CLI → activate MasterPlan ──
  if (ctx.planning.planApproved && ctx.options.planText && ctx.planning.taskTracker) {
    markPlanAccepted(ctx.planning.taskTracker)
    if (activateMasterPlan(ctx, ctx.options.planText, ctx.planning.taskTracker.goal)) {
      yield stream({ type: "status", data: `master-plan: ${planProgress(ctx.planStore.current!)} nodes` })
    }
    yield stream({ type: "status", data: "任务追踪: 用户已确认规划，进入执行阶段" })
    yield patch({ planning: { planApproved: false } })
  }

  return { kind: "continue" }
}
