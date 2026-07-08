/** Agent while-True tool loop — with self-learn triggers, staged context, thinking store, post-edit lint. */

import type { LLMProvider, ProviderMessage, ProviderTokenUsage, StreamEvent } from "../provider/types"
import { classifyProviderError } from "../provider/retry"
import type { ToolDescriptor, ToolResult } from "../tools/registry"
import { createState, decideThinkingPlan, updateState } from "./router"
import { buildSystemPrompt } from "./prompts"
import { CacheTracker } from "../provider/cache-tracker"
import type { StagedContextManager } from "../context/staged"
import type { ThinkingStore } from "../memory/thinking-store"
import type { KnowledgeBase } from "../memory/knowledge"
import { distillAndStore, shouldDistill } from "../memory/distiller"
import { buildContextKernel } from "../context/kernel"
import { classifyIntent } from "./intent"
import { FlashTriage, triageModeToIntent, triageToTaskIntent, buildTrackerFromTriage, activateSkillNamesByKeywords, resolveFlashTriagePolicy, shouldUseFlashTriage } from "./flash-triage"
import { activateSkillsByNames } from "../skills/registry"
import { revisePlan } from "./task-tracker"
import type { TaskPacket } from "./task-packet"
import { createMasterPlan, createMasterPlanFromPacket, nodesFromPlanText, markNodeDone, buildNodeReviewGate, currentNode, planComplete, planProgress, planRef, type MasterPlan } from "./master-plan"
import { validatePlan, validateNode, formatValidationReport } from "./plan-validator"
import { mergeProviderTokenUsage } from "../provider/usage"
import { setRuntimeContextBudgetMode } from "./runtime-context"
import type { RippleReport } from "../ripple/types"
import { getBlockingObligations, mergeObligations, normalizeProjectPath, obligationsFromReport, resolveObligations, type RippleObligation } from "../ripple/obligations"
import { setCascadeFiles } from "../ripple/engine"
import type { ModelRouter } from "../provider/router"
import { ConfidenceEvaluator } from "../evaluator/confidence"
import { AgentState, StateMachine } from "./state-machine"
import { compactAssistantContext } from "./round/helpers"
import { runPostEditDiagnostics, runRippleVerification, collectThinkingRounds, isRecord, collectRecentTurns, mcThreshold, microcompactToolResults, compactHistoricalToolResults, updateStateMachine, type StateMachineInput } from "./round/post-loop"
import { ErrorTracker, withToolTimeout, nextProviderEvent, providerIdleTimeoutMs, runToolBeforeHook, runToolAfterHook, appendHookWarnings, executeToolWithHooks, buildVolatileContextMessage, collectResearchEvidence, containsTypecheckFailure, countTypecheckIssues, isVerificationUnavailable, isRuntimeProjectRoot, isRuntimeSourceFile, rootRuntimeVerificationPassed, formatRuntimeSelfEditGate, normalizeExplicitFile, explicitRequiredFiles, missingExplicitRequiredFiles } from "./round/pre-loop"
import type { HookSystem } from "../hooks"
import { formatSkippedProviderPurpose, shouldSkipProviderPurpose } from "../provider/cost-policy"
import { formatToolLedgerStatus, ToolExecutionLedger } from "./tool-ledger"
import { runTypeScriptNoEmit } from "../tools/typescript"

import { formatServiceTestGuidance, hasServiceTestFailure, type VerificationResult } from "../verification/result"
import type { AgentRunTrace } from "./run-trace"
import {
  createTaskTracker,
  formatTaskPlanningPrompt,
  formatTaskTrackerPrompt,
  formatTaskTrackerStatus,
  markPlanAccepted,
  missingTaskRequirements,
  snapshotTaskTracker,
  updateTaskTrackerAfterTools,
} from "./task-tracker"
import { buildEffectivePrompt, buildModelClarificationCall, evaluateClarificationNeed, formatModelClarificationFailure, parseModelClarification } from "./clarification"
import { buildExperienceKernelContext } from "../experience/kernel"
import { compactThinkingChain } from "../memory/compactor"
import { evaluatePlanningArtifact, forcePlanningPassAfterLimit, formatPlanningBlockedToolResult, formatPlanningGatePrompt } from "./planning-gate"
import { detectLanguage, languageInstruction, type UILanguage } from "./language"
import { CompletionOrchestrator, checkNarrowEditCompletion } from "./completion-orchestrator"
import { canClaimDone } from "./evidence-ledger"
import { formatGenericProviderStreamBlockedReport, formatGenericProviderStreamRecoveryPrompt, formatProviderStreamBlockedReport, formatProviderStreamRecoveryPrompt } from "./runtime-failure"
import { buildResearchEvidenceContext, buildResearchInsufficientEvidenceMessage, type ResearchEvidence } from "./research-answer"
import { classifyResearchRoute, shouldRunResearch } from "./research-router"
import { FlashJudge, TestimonyLedger } from "./flash-judge"
import { PermissionGate } from "./permission"
import { loadUserConfig, loadProjectConfig } from "./permission-config"
import { evaluateToolPolicy } from "./tool-execution/policy"
import { GateTelemetry } from "./gates/telemetry"
import { SandboxManager } from "../sandbox/sandbox"
import { setShellSandbox } from "../tools/shell"
import { saveCheckpoint, adaptiveCheckpointThreshold, shouldSkipCheckpointThisRound, recordCheckpointTaken, formatCheckpointSummary, generateCheckpointId, type ComplexityMetrics } from "../session/checkpoint"
import { buildContextMessages, buildRoundProviderRequest, cacheStableProviderTools, estimateRoundTokens } from "./round/request-builder"
import { createPreRoundChain } from "./gates/pre-round"
import { processGateOverflow } from "./gates/overflow"
import { createEpochState, buildPlanStateContext, classifyEpochAction, formatEpochBudgetWarning, formatEpochStatus, totalMessageChars, epochRollover, type PlanStateInput } from "./context-epoch"
import { setActivePatchContext } from "./patch-transaction"
import { createEvidenceLedger, type EvidenceLedger } from "./evidence-ledger"
import { setActiveMode, getActiveMode, formatModePrompt, shouldTransitionMode } from "./mode-contract"
import type { ModeTransitionContext } from "./mode-contract"
import { buildContextMap, contextEvidenceForMap, evaluateContextReadiness, formatContextMapSummary, selectContextMapTaskLevel, type ContextMap, type ContextMapTaskLevel } from "../context/context-map"

import type { UsageStats, AgentOptions } from "./loop-types"
export type { UsageStats, AgentOptions }

export async function* agentLoop(
  prompt: string,
  options: AgentOptions,
): AsyncGenerator<StreamEvent> {
  const maxRoundsFromEnv = process.env.DEEPSEEK_MAX_ROUNDS ? parseInt(process.env.DEEPSEEK_MAX_ROUNDS, 10) : undefined
  const { provider, model, tools, maxRounds = maxRoundsFromEnv ?? 50, stagedContext, hooks } = options
  const startTime = Date.now() // PR-7.2: for Stop hook session duration
  const effectivePrompt = buildEffectivePrompt(prompt, options.conversationHistory)
  const language = detectLanguage(effectivePrompt)
  const langInstruction = languageInstruction(language)

  const rawMessages: ProviderMessage[] = []

  // Load conversation history up to a token budget (~15% of 1M context).
  // This replaces the hardcoded slice(-24) with budget-aware truncation.
  if (options.conversationHistory?.length) {
    const ESTIMATED_CHARS_PER_TOKEN = 3
    const HISTORY_TOKEN_BUDGET = 150_000
    let used = 0
    const recent = options.conversationHistory.length > 60
      ? options.conversationHistory.slice(-60)
      : options.conversationHistory
    for (const h of recent) {
      const est = Math.ceil(h.content.length / ESTIMATED_CHARS_PER_TOKEN)
      if (used + est > HISTORY_TOKEN_BUDGET) break
      used += est
      rawMessages.push({ role: h.role, content: h.content })
    }
  }

  rawMessages.push({ role: "user", content: prompt })

  // PR-7.2: Dispatch UserPromptSubmit hook — can inject context, replace prompt, or block
  if (hooks) {
    const promptResult = await hooks.dispatchPromptSubmit({ prompt, round: 0 })
    if (promptResult.blocked) {
      yield { type: "error", data: `Prompt blocked by hook: ${promptResult.blockReason}` }
      if (hooks) {
        await hooks.dispatchStop({ reason: "blocked", totalRounds: 0, sessionDurationMs: Date.now() - startTime })
      }
      return
    }
    if (promptResult.replacePrompt) {
      // Replace the last user message with the transformed prompt
      rawMessages[rawMessages.length - 1] = { role: "user", content: promptResult.replacePrompt }
    }
    if (promptResult.context) {
      // Inject hook-provided context as a system message before the user prompt
      rawMessages.splice(rawMessages.length - 1, 0, { role: "system", content: promptResult.context })
    }
    // SessionStart context is injected by the caller via options.sessionStartContext
    if (options.sessionStartContext) {
      rawMessages.splice(rawMessages.length - 1, 0, { role: "system", content: options.sessionStartContext })
    }
  }

  const state = createState()
  const cacheTracker = new CacheTracker()
  const errorTracker = new ErrorTracker()
  const gateTelemetry = options.gateTelemetry ?? new GateTelemetry()

  // ── Load accumulated telemetry from previous runs (additive merge) ──
  if (!options.gateTelemetry && options.gateTelemetryFile) {
    const prev = await GateTelemetry.loadFromFile(options.gateTelemetryFile).catch(() => new GateTelemetry())
    gateTelemetry.merge(prev)
  }

  // ── Helper: save telemetry to disk (called at all exit points) ──
  const flushTelemetry = async () => {
    if (gateTelemetry.gateNames().length === 0) return
    if (!options.gateTelemetryFile) return
    // Ensure parent directory exists
    const path = await import("node:path")
    const fs = await import("node:fs/promises")
    const dir = path.dirname(options.gateTelemetryFile)
    await fs.mkdir(dir, { recursive: true }).catch(() => {})
    await gateTelemetry.saveToFile(options.gateTelemetryFile).catch(() => {})
  }

  const contextKernel = buildContextKernel(process.cwd())

  // ── Flash Triage: semantic task classification (replaces 4 keyword classifiers) ──
  const flashTriagePolicy = options.flashTriagePolicy ?? resolveFlashTriagePolicy()
  const flashTriageEnabled = shouldUseFlashTriage(flashTriagePolicy, effectivePrompt, contextKernel.text)
  const triageModel = options.modelRouter?.selectForPurpose("flash_triage") ?? "deepseek-v4-flash"
  const flashTriage = flashTriageEnabled ? new FlashTriage(provider, triageModel) : null
  const triageResult = flashTriage ? await flashTriage.triage(effectivePrompt, contextKernel.text) : null
  let intentPolicy: ReturnType<typeof classifyIntent>
  let taskTracker: ReturnType<typeof createTaskTracker> = null
  let masterPlan: MasterPlan | null = null
  let evidenceLedger: EvidenceLedger = createEvidenceLedger()
  let lastPlanText = ""
  let researchContext: ProviderMessage | null = null
  let researchEvidence: ResearchEvidence[] = []
  let triageSkillPrompts: string[] = []

  if (triageResult) {
    // Flash succeeded — use semantic classification
    intentPolicy = { mode: triageModeToIntent(triageResult.mode), reason: `Flash triage: ${triageResult.reasoning}` }
    const trackerDef = buildTrackerFromTriage(triageResult, effectivePrompt)
    if (trackerDef) {
      taskTracker = { ...trackerDef, verificationEvidence: {}, verification: trackerDef.requiredVerificationKinds.map(k => k === "typecheck" ? "运行类型检查" : k === "test" ? "运行测试" : k === "build" ? "运行构建" : "运行验证") }
    }
    triageSkillPrompts = activateSkillsByNames(triageResult.relevantSkillNames)
  } else {
    // Flash unavailable — fallback to classifiers
    // PR-2.3: long_task now routes through TaskPacket path; narrow_edit still uses keyword-based
    intentPolicy = classifyIntent(effectivePrompt)
    if (intentPolicy.mode === "long_task") {
      const { buildTaskTrackerFromPrompt } = await import("./task-packet")
      taskTracker = buildTaskTrackerFromPrompt(effectivePrompt, intentPolicy.mode)
    } else {
      taskTracker = createTaskTracker(effectivePrompt, intentPolicy.mode)
    }
    triageSkillPrompts = activateSkillsByNames(activateSkillNamesByKeywords(effectivePrompt))
  }

  const researchDecision = triageResult?.needsWeb && triageResult.researchQueries.length > 0
    ? {
        mode: "research_answer" as const,
        confidence: 0.85,
        needWeb: true,
        reason: `Flash triage: ${triageResult.reasoning}`,
        researchQuestions: triageResult.researchQueries,
      }
    : classifyResearchRoute({ prompt: effectivePrompt, intentMode: intentPolicy.mode })
  const experienceContext = buildExperienceKernelContext({ prompt: effectivePrompt, intentMode: intentPolicy.mode })
  let announcedKernel = false
  let webSearchFailedThisTurn = false
  let webSearchFailReason = ""
  let announcedContextDegraded = false
  let announcedEpochForceCompress = false
  let pendingRippleObligations: RippleObligation[] = []
  const cacheStableTools = process.env.DEEPSEEK_CACHE_STABLE_TOOLS !== "0"
  const confidenceEvaluator = new ConfidenceEvaluator()
  const judgeModel = options.modelRouter?.selectForPurpose("completion_judge") ?? "deepseek-v4-flash"
  const flashJudge = new FlashJudge(provider, judgeModel)
  const testimonyLedger = new TestimonyLedger()
  const permissionGate = new PermissionGate()
  // Load user + project permission configs (gracefully)
  const userCfg = loadUserConfig()
  const projectCfg = loadProjectConfig(process.cwd())
  permissionGate.loadRules(userCfg?.rules ?? [], projectCfg?.rules ?? [])
  // Sandbox init — shared Job Object for all shell commands in this agent run
  const sandbox = new SandboxManager({
    projectRoot: process.cwd(),
    maxRuntimeSec: Number(process.env.DEEPSEEK_SANDBOX_TIMEOUT_SEC) || 30,
    jobMemoryLimitMb: process.env.DEEPSEEK_SANDBOX_MEMORY_MB ? Number(process.env.DEEPSEEK_SANDBOX_MEMORY_MB) : 512,
  })
  setShellSandbox(sandbox)
  // PR 8: set active mode contract from options (defaults to "coder")
  setActiveMode(options.activeMode ?? "coder")
  const pmode: "full" | "strict" = process.env.DEEPSEEK_PERMISSION_MODE === "strict" ? "strict" : "full"
  const toolLedger = new ToolExecutionLedger()
  let rippleBlockActive = false
  const gateBlockCounts = new Map<string, { count: number; lastSeen: number }>()
  const deferredGateMessages: string[] = []
  let thinkingTokenTotal = 0
  let microcompactCount = 0
  let rateLimitShell = 0
  let rateLimitFile = 0
  let rateLimitNetwork = 0
  let planApproved = options.initialPlanState === "approved"
  let planningRejections = 0
  let taskHadWrite = false
  let taskToolErrors = 0
  let taskModifiedFiles = 0
  let consecutiveErrors = 0
  let requestedMaxThinking = false
  let lastKernelHash = ""
  let thinkingCompacted = false
  let frozenStablePrefix: ProviderMessage | null = null
  let stablePrefixHash = ""
  let lastTypecheck: { passed: boolean; issues: number; output?: string } | undefined
  let lastRippleReports: RippleReport[] = []
  let lastToolNames: string[] = []
  let lastVerificationResults: VerificationResult[] = []
  let runtimeSelfEditFiles = new Set<string>()
  const taskFiles = new Set<string>()
  options.runTrace?.record("agent_loop_started", { maxRounds, toolCount: tools.length })

  // ── State machine — validates transitions, secondary to ad-hoc flags ──
  const sm = new StateMachine()
  sm.transition(AgentState.UNDERSTAND, "agent loop started")

  const clarification = evaluateClarificationNeed({
    prompt: effectivePrompt,
    tracker: taskTracker,
    history: options.conversationHistory,
  })
  if (clarification.required) {
    yield { type: "status", data: "clarification-gate: thinking before planning" }
    let modelText = ""
    let modelFailed = !taskTracker
    let modelInputTokens = 0
    if (taskTracker) {
      const clarificationCall = buildModelClarificationCall({
        provider,
        model,
        prompt: effectivePrompt,
        tracker: taskTracker,
        result: clarification,
        language,
      })
      modelInputTokens = Math.max(1, Math.round((clarificationCall.system.length + JSON.stringify(clarificationCall.messages).length) / 3))
      try {
        for await (const event of provider.streamChat(clarificationCall)) {
          if (event.type === "text") {
            const chunk = String(event.data ?? "")
            modelText += chunk
            yield {
              type: "token_usage",
              data: {
                inputTokens: modelInputTokens,
                outputTokens: Math.max(1, Math.round(modelText.length / 3)),
                contextMax: 1_048_576,
                cacheSource: "estimate",
              },
            }
          } else if (event.type === "status" || event.type === "error" || event.type === "token_usage") {
            yield event
          }
        }
      } catch {
        modelFailed = true
      }
    }

    const structuredClarification = !modelFailed
      ? parseModelClarification(modelText, clarification.originalPrompt ?? effectivePrompt)
      : null
    if (structuredClarification) {
      yield { type: "clarification_ready", data: structuredClarification }
    } else {
      yield { type: "error", data: formatModelClarificationFailure() }
    }
    options.runTrace?.record("gate_decision", {
      gate: "clarification",
      decision: "ask",
      reason: clarification.reason,
      source: structuredClarification ? "model_structured" : "model_failed",
    })
    await flushTelemetry()
    if (hooks) {
      await hooks.dispatchStop({ reason: "aborted", totalRounds: 0, sessionDurationMs: Date.now() - startTime })
    }
    return
  }

  if (shouldRunResearch(researchDecision)) {
    yield { type: "status", data: `research-router: ${researchDecision.reason}` }
    options.runTrace?.record("gate_decision", {
      gate: "research_router",
      decision: "research_answer",
      reason: researchDecision.reason,
      questions: researchDecision.researchQuestions,
    })
    researchEvidence = await collectResearchEvidence({
      tools,
      queries: researchDecision.researchQuestions,
      hooks,
    })
    const successCount = researchEvidence.filter(item => item.success).length
    yield { type: "status", data: `research-router: evidence ${successCount}/${researchEvidence.length}` }
    researchContext = successCount > 0
      ? buildResearchEvidenceContext(researchDecision, researchEvidence)
      : { role: "user", content: buildResearchInsufficientEvidenceMessage(researchDecision, researchEvidence) }
  } else if (researchDecision.mode === "deep_discussion") {
    options.runTrace?.record("gate_decision", {
      gate: "research_router",
      decision: "deep_discussion",
      reason: researchDecision.reason,
      needWeb: researchDecision.needWeb,
    })
  }

  const envContextMapPolicy = process.env.DEEPSEEK_CONTEXT_MAP
  const contextMapPolicy: "off" | "auto" | "always" = options.contextMapPolicy ?? (
    envContextMapPolicy === "off" || envContextMapPolicy === "always"
      ? envContextMapPolicy
      : "auto"
  )
  const explicitFilesForContext = explicitRequiredFiles(effectivePrompt)
  const contextMapLevel: ContextMapTaskLevel = selectContextMapTaskLevel({
    userRequest: effectivePrompt,
    risk: triageResult?.riskLevel === "high" ? "high" : undefined,
    touchedFiles: explicitFilesForContext.length,
  })
  const shouldBuildContextMap = contextMapPolicy === "always" ||
    (contextMapPolicy === "auto" && intentPolicy.mode !== "readonly" && (
      contextMapLevel === "long" ||
      contextMapLevel === "high_risk" ||
      explicitFilesForContext.length > 0
    ))
  let runtimeContextMap: ContextMap | null = null
  let contextMapContext = ""
  let contextReadinessBlockers: string[] = []
  let contextReadinessBlocked = false
  if (shouldBuildContextMap) {
    runtimeContextMap = buildContextMap(process.cwd(), {
      taskId: "runtime-task",
      userRequest: effectivePrompt,
      keywords: explicitFilesForContext,
    })
    const readiness = evaluateContextReadiness(runtimeContextMap, contextMapLevel)
    contextReadinessBlockers = readiness.blockers
    contextReadinessBlocked = contextMapLevel === "high_risk" && contextReadinessBlockers.length > 0
    contextMapContext = [
      "## Context Map",
      `level: ${contextMapLevel}`,
      formatContextMapSummary(runtimeContextMap),
      `readiness: ${contextReadinessBlockers.length ? contextReadinessBlockers.join(" | ") : "ready"}`,
      contextReadinessBlocked ? "ContextReadiness blocked write tools until more context is acquired." : "",
    ].filter(Boolean).join("\n")
    yield { type: "status", data: `context-map: ${runtimeContextMap.id} ${contextMapLevel} ${contextReadinessBlockers.length ? "blocked" : "ready"}` }
    options.runTrace?.record("gate_decision", {
      gate: "context_readiness",
      decision: contextReadinessBlocked ? "block_writes" : "pass",
      level: contextMapLevel,
      blockers: contextReadinessBlockers,
      contextMapId: runtimeContextMap.id,
    })
  }
  const planContextAttachment = runtimeContextMap
    ? { contextMapId: runtimeContextMap.id, requiredContextEvidence: contextEvidenceForMap(runtimeContextMap) }
    : undefined

  const usage: UsageStats = { apiCalls: 0, estimatedInputTokens: 0, cacheHits: 0, cacheMisses: 0, flashRounds: 0, proRounds: 0, flashUsed: false }

  // Cumulative context tracking (DeepSeek V4: 1M context window)
  let contextInputTotal = 0
  let contextOutputTotal = 0
  const CONTEXT_MAX = 1_048_576

  // ── Context Epoch (PR 4): four-layer context architecture ──
  const epochState = createEpochState()

  const syncModeWithMasterPlan = (): void => {
    if (!masterPlan) return
    const activeNode = currentNode(masterPlan)
    const transitionCtx: ModeTransitionContext = {
      activeNodeStatus: activeNode?.status,
      hasTrackerSteps: (activeNode?.tracker?.steps?.length ?? 0) > 0,
      rippleObligationCount: pendingRippleObligations.length,
      hasEvidence: evidenceLedger.entries.length > 0,
      toolErrors: errorTracker.errorCount,
      planComplete: planComplete(masterPlan),
    }
    const newMode = shouldTransitionMode(getActiveMode().mode, transitionCtx)
    if (newMode) {
      setActiveMode(newMode)
    }
  }

  // ── MasterPlan: activate from planning artifact ──
  const activateMasterPlan = (planText: string, goal: string, forcePassPacket?: TaskPacket): boolean => {
    // PR 3: if force-passed with a minimal viable packet, use it directly
    if (forcePassPacket) {
      const packet = planContextAttachment
        ? {
            ...forcePassPacket,
            contextMapId: forcePassPacket.contextMapId ?? planContextAttachment.contextMapId,
            requiredContextEvidence: forcePassPacket.requiredContextEvidence?.length
              ? forcePassPacket.requiredContextEvidence
              : planContextAttachment.requiredContextEvidence,
          }
        : forcePassPacket
      const plan = createMasterPlanFromPacket(packet, "long_task")
      planRef.current = plan; masterPlan = plan
      const cur = currentNode(plan)
      if (!cur) return false
      taskTracker = cur.tracker
      // PR 5: set active patch context from node's TaskPacket
      if (cur._packet) {
        setActivePatchContext({
          scope: cur._packet.scope,
          verification: cur._packet.verification.map(v => v.kind),
          nodeId: cur.id,
        })
      }
      syncModeWithMasterPlan()
      return true
    }

    const nodes = nodesFromPlanText(planText)
    const titles = nodes.length > 0
      ? nodes.map(n => n.title)
      : [goal.slice(0, 120) || "主要任务"]
    const plan = createMasterPlan(goal, "long_task", titles, planContextAttachment)
    // Transfer parsed dependencies
    for (let i = 0; i < Math.min(nodes.length, plan.nodes.length); i++) {
      for (const depIdx of nodes[i]?.dependsOn ?? []) {
        const dep = plan.nodes[depIdx - 1]
        const cur = plan.nodes[i]
        if (dep && cur && !cur.dependsOn.includes(dep.id)) {
          cur.dependsOn.push(dep.id); dep.blockedBy.push(cur.id)
        }
      }
    }
    planRef.current = plan; masterPlan = plan
    // PR 3: re-validate after dependency transfer — mutations may introduce cycles
    plan._lastValidation = validatePlan(plan)
    const cur = currentNode(plan)
    if (!cur) return false
    taskTracker = cur.tracker
    // PR 5: set active patch context from node's TaskPacket
    if (cur._packet) {
      setActivePatchContext({
        scope: cur._packet.scope,
        verification: cur._packet.verification.map(v => v.kind),
        nodeId: cur.id,
      })
    }
    syncModeWithMasterPlan()
    return true
  }

  // ── MasterPlan node transition — called after current node passes all completion gates ──
  const tryNodeTransition = (): boolean => {
    if (!masterPlan || !taskTracker) return false
    const cur = currentNode(masterPlan)
    if (cur) markNodeDone(masterPlan, cur.id, "验证通过")
    const review = buildNodeReviewGate(masterPlan, cur?.id ?? "")
    // PR 3: validate plan before injecting review prompt
    masterPlan._lastValidation = validatePlan(masterPlan)
    // Inject as user message — this is an instruction to review the plan, not model output
    const validationText = formatValidationReport(masterPlan._lastValidation)
    const fullPrompt = validationText
      ? `${review.promptText.slice(0, 1600)}\n\n${validationText}`
      : review.promptText.slice(0, 2000)
    rawMessages.push({ role: "user" as const, content: fullPrompt })
    syncModeWithMasterPlan()
    if (planComplete(masterPlan)) return false
    // Blocked nodes still need model review — continue even when !review.resume
    if (review.remaining === 0) return false
    // If next node was auto-activated, swap to its tracker
    const next = currentNode(masterPlan)
    if (next && review.resume) {
      taskTracker = next.tracker
      // PR 5: set active patch context from next node's TaskPacket
      if (next._packet) {
        setActivePatchContext({
          scope: next._packet.scope,
          verification: next._packet.verification.map(v => v.kind),
          nodeId: next.id,
        })
      }
    }
    syncModeWithMasterPlan()
    return true
  }

  if (planApproved && options.planText && taskTracker) {
    markPlanAccepted(taskTracker)
    if (activateMasterPlan(options.planText, taskTracker.goal)) {
      yield { type: "status", data: `master-plan: ${planProgress(masterPlan!)} nodes` }
    }
    yield { type: "status", data: "任务追踪: 用户已确认规划，进入执行阶段" }
    planApproved = false
  }

  let finalRound = 0 // PR-7.2: tracked for Stop hook outside loop scope
  for (let round = 0; round < maxRounds; round++) {
    finalRound = round
    options.runTrace?.record("round_started", { round })
    const thinkingDecision = decideThinkingPlan(state, requestedMaxThinking ? "max" : options.thinkEffort, {
      prompt: effectivePrompt,
      intentMode: intentPolicy.mode,
      planningPhase: taskTracker?.phase === "planning",
      autoMaxSignals: { consecutiveErrors, modifiedFiles: taskModifiedFiles },
    })
    const thinking = thinkingDecision.thinking
    const maxTok = thinkingDecision.maxTokens
    options.runTrace?.record("thinking_decision", { round, ...thinkingDecision })

    // Project context
    let ctxText = ""
    if (stagedContext && (stagedContext.loadedFiles.size > 0 || state.roundNum > 0)) {
      ctxText = stagedContext.buildContext().toPromptText()
    }

    // Thinking store
    let thinkContext = ""
    if (options.thinkingStore && state.roundNum > 0) {
      thinkContext = options.thinkingStore.formatForPrompt(options.thinkingStore.findSimilar(prompt))
    }

    // Knowledge base
    let knowledgeContext = ""
    if (options.knowledgeBase && state.roundNum > 1) {
      const hits = options.knowledgeBase.findRelevant(prompt)
      if (hits.length > 0) {
        knowledgeContext = "\n## 已学知识\n" + hits.map(e =>
          `问题: ${e.problem}\n方案: ${e.solution}`
        ).join("\n\n") + "\n"
      }
    }

    const system = buildSystemPrompt()
    // ── Frozen stable prefix: computed once on round 0, reused across all rounds ──
    if (!frozenStablePrefix) {
      const stablePrefixParts: string[] = []
      if (options.stableMemoryContext?.trim()) stablePrefixParts.push(`## Stable Cold Memory\n${options.stableMemoryContext.trim()}`)
      if (experienceContext) stablePrefixParts.push(experienceContext)
      if (contextKernel.text) stablePrefixParts.push(`## Project Context Kernel\n${contextKernel.text}`)
      if (contextMapContext) stablePrefixParts.push(contextMapContext)
      if (triageSkillPrompts.length) stablePrefixParts.push(triageSkillPrompts.join("\n\n"))
      frozenStablePrefix = stablePrefixParts.length > 0
        ? { role: "user", content: ["## Stable Prefix Context\n[CACHE_ANCHOR:v3]", stablePrefixParts.join("\n\n")].join("\n\n") }
        : null
    }
    const stablePrefixContext = frozenStablePrefix
    // ── Plan State Context (PR 4, Layer 2): survives epoch rollover ──
    const planStateInput: PlanStateInput = {
      masterPlan: planRef.current,
      taskTracker,
      taskPacket: planRef.current
        ? (currentNode(planRef.current)?._packet ?? null)
        : null,
      rippleObligations: pendingRippleObligations,
      userGoal: planRef.current?.goal ?? taskTracker?.goal ?? effectivePrompt.slice(0, 200),
      decisions: [], // TODO PR 6/7: wire Evidence/Ripple decisions into plan state
      round,
    }
    const planStateText = buildPlanStateContext(planStateInput)
    const planStateContext: ProviderMessage | null = planStateText.length > 0
      ? { role: "user", content: planStateText }
      : null
    const volatileContext = buildVolatileContextMessage(ctxText, thinkContext, knowledgeContext)
    const taskPlanning = taskTracker?.phase === "planning"
    const planningContext: ProviderMessage | null = taskPlanning && taskTracker
      ? { role: "user", content: formatTaskPlanningPrompt(taskTracker, round) }
      : null
    // ── Context messages: all go BEFORE rawMessages ──
    // Anthropic API requires tool_use→tool_result adjacency. Any user
    // message inserted between an assistant(tool_use) and user(tool_result)
    // is a 400 error. So volatile/planning/budget context must precede
    // rawMessages, never follow it.
    const contextMessages = buildContextMessages({
      langInstruction,
      stablePrefixContext,
      planStateContext,
      researchContext,
      volatileContext,
      planningContext,
    })

    // PR 8: inject mode contract prompt — tells model what mode it's in
    const modeContext = formatModePrompt(getActiveMode())
    if (modeContext) {
      contextMessages.push({ role: "user", content: modeContext })
    }

    // ── Epoch check: estimate total chars and classify action ──
    const epochTotalChars = totalMessageChars(contextMessages) + totalMessageChars(rawMessages)
    const epochAction = classifyEpochAction(epochTotalChars, epochState.thresholds)
    if (epochAction !== "none") {
      yield { type: "status", data: formatEpochStatus(epochState, round, epochTotalChars) }
    }

    // ── Epoch rollover (PR 4): archive volatile tail when threshold reached ──
    if (epochAction === "rollover") {
      const rolloverResult = epochRollover(rawMessages, 3 /* keep 3 most recent turns */, planStateText, epochState, round)
      if ("blocked" in rolloverResult) {
        yield { type: "status", data: `epoch-rollover: blocked — ${rolloverResult.reason}` }
        // Continue without rollover; will retry next round
      } else {
        // Replace rawMessages with rolled-over version
        while (rawMessages.length > 0) rawMessages.pop()
        for (const m of rolloverResult.messages) rawMessages.push(m)
        epochState.currentEpochIndex++
        epochState.epochStartRound = round
        epochState.rolloverCount++
        epochState.totalCharsTrimmed += rolloverResult.charsTrimmed
        epochState.snapshots.push(rolloverResult.snapshot)
        yield { type: "status", data: `epoch-rollover: ${rolloverResult.archivedCount} messages archived (${rolloverResult.charsTrimmed} chars), ${rawMessages.length} messages retained` }
        options.runTrace?.record("epoch_rollover", {
          epochIndex: rolloverResult.snapshot.index,
          round,
          archivedCount: rolloverResult.archivedCount,
          charsTrimmed: rolloverResult.charsTrimmed,
        })
      }
    }
    if (!announcedKernel) {
      announcedKernel = true
      yield { type: "status", data: `context-kernel: ${contextKernel.hash} (~${contextKernel.estimatedTokens} tokens)` }
    }

    // Use session model for all rounds — model switching breaks prefix cache
    const modelName = model
    usage.proRounds++
    options.runTrace?.record("model_selected", {
      round,
      requestedModel: modelName,
      route: "configured_model",
      thinkingEnabled: Boolean(thinking),
      maxTokens: maxTok,
    })

    usage.apiCalls++

    // ── Pre-round gate chain: context budget → tool disclosure → readonly/plan → ripple filter ──
    const preTokens = estimateRoundTokens(system, contextMessages, rawMessages, null)
    const contextText = preTokens.providerMessages.map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n").slice(-4000) + "\n" + system
    const preRoundCtx = {
      round,
      roundInputTokens: preTokens.roundInputTokens,
      contextMax: CONTEXT_MAX,
      fullTools: tools,
      tools,
      rippleReports: lastRippleReports,
      pendingRippleObligations,
      intentReadonly: intentPolicy.mode === "readonly",
      taskPlanning: Boolean(taskPlanning),
      contextReadinessBlocked,
      cacheStableTools,
      disclosureContextText: contextText,
      contextBudgetMode: "normal" as const,
      contextBudgetPercent: 0,
      budgetMessage: null as ProviderMessage | null,
      announcedDegraded: announcedContextDegraded,
      rippleBlockActive: false,
      contextReadinessBlockActive: false,
      tokensSaved: 0,
      activeTools: tools,
    }
    const preRoundChain = createPreRoundChain()
    const preRoundResult = preRoundChain.evaluateSync(preRoundCtx, gateTelemetry)

    setRuntimeContextBudgetMode(preRoundCtx.contextBudgetMode)
    const budgetContext = preRoundCtx.budgetMessage
    const { roundInputTokens, providerMessages } = estimateRoundTokens(
      system, contextMessages, rawMessages, budgetContext,
    )
    const estimatedRoundInputTokens = roundInputTokens
    usage.estimatedInputTokens += roundInputTokens
    contextInputTotal += roundInputTokens

    if (!preRoundResult.pass) {
      // Context budget block — hard exit
      yield { type: "status", data: `context-budget: block ${preRoundCtx.contextBudgetPercent}%` }
      options.runTrace?.record("gate_decision", { gate: "policy:context_budget", decision: "block", percent: preRoundCtx.contextBudgetPercent })
      yield { type: "text", data: preRoundResult.message ?? "Context budget exceeded." }
      break
    }
    if ((preRoundCtx.contextBudgetMode as string) === "degraded" && !announcedContextDegraded) {
      announcedContextDegraded = true
      yield { type: "status", data: `context-budget: degraded ${preRoundCtx.contextBudgetPercent}%; finish current stage only` }
    }

    // ── PR 4: Epoch budget warning on force-compress (one-shot) ──
    if (epochAction === "forceCompress" && !announcedEpochForceCompress) {
      announcedEpochForceCompress = true
      const epochWarning = formatEpochBudgetWarning(
        Math.round((epochTotalChars / epochState.thresholds.forceCompressChars) * 100),
        epochState.thresholds,
      )
      // Inject as a user message into rawMessages to warn the model
      rawMessages.push({ role: "user", content: epochWarning })
      yield { type: "status", data: `epoch-budget: force-compress — ${Math.round(epochTotalChars / 1000)}k chars` }
    }

    // Apply ripple block side effects
    rippleBlockActive = preRoundCtx.rippleBlockActive
    if (rippleBlockActive) {
      for (const report of lastRippleReports) sandbox.blockFileWrite(report.targetFile)
    }

    const activeTools = cacheStableTools && !preRoundCtx.contextReadinessBlockActive
      ? cacheStableProviderTools(tools)
      : preRoundCtx.activeTools

    if (!cacheStableTools && preRoundCtx.tokensSaved > 0) {
      yield { type: "status", data: `tools: ${activeTools.length}/${tools.length} (↓${preRoundCtx.tokensSaved} tokens)` }
    }
    if (round === 0 && intentPolicy.mode === "readonly") {
      yield { type: "status", data: `intent-gate: readonly (${intentPolicy.reason})` }
    }
    if (round === 0 && taskTracker) {
      yield { type: "status", data: "任务追踪: 已识别为长任务，先规划再执行" }
    }
    if (taskTracker) {
      const status = formatTaskTrackerStatus(taskTracker)
      if (status) yield { type: "status", data: status }
      yield { type: "task_progress", data: snapshotTaskTracker(taskTracker) }
    }
    if (preRoundCtx.taskPlanning && round > 0) {
      yield { type: "status", data: "任务追踪: 规划阶段只输出计划" }
    }
    if (rippleBlockActive) {
      yield { type: "status", data: `涟漪阻止: 写工具已禁用 (${pendingRippleObligations.length} 个调用方未更新)` }
      options.runTrace?.record("gate_decision", { gate: "ripple_block", decision: "block", pending: pendingRippleObligations.length })
    }
    const roundRequest = buildRoundProviderRequest({
      modelName,
      system,
      providerMessages,
      tools: activeTools,
      cacheTracker,
      thinkingTokenTotal,
      contextInputTotal,
      contextOutputTotal,
      contextMax: CONTEXT_MAX,
      round,
      contextUsagePercent: preRoundCtx.contextBudgetPercent,
    })
    const { providerToolSchemas, cacheAnatomy, cacheShape, cacheStatus, estimatedUsageEvent } = roundRequest
    if (cacheStatus === "hit") { usage.cacheHits++ } else { usage.cacheMisses++ }
    options.runTrace?.record("cache_prefix_shape", {
      round,
      cacheStatus,
      prefixHash: cacheShape.prefixHash,
      firstChangedSection: cacheShape.firstChangedSection,
      sections: cacheShape.sections,
    })
    options.runTrace?.record("token_usage", estimatedUsageEvent)
    yield { type: "token_usage", data: estimatedUsageEvent }
    yield { type: "status", data: thinking ? thinkingDecision.visibleStatus : "working" }

    const textChunks: string[] = []
    const completedToolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = []
    let thinkingBlocks: Array<{ thinking: string; signature: string }> = []
    let streamError = ""
    let streamErrorRetryable = true
    let streamErrorYielded = false
    const roundStart = Date.now()
    let bufferedTextEmitted = false
    const shouldBufferCompletionText = taskTracker?.phase === "building" || taskTracker?.phase === "complete" || taskHadWrite || taskToolErrors > 0
    const bufferReadonlyText = intentPolicy.mode === "readonly" || shouldBufferCompletionText
    let providerUsage: ProviderTokenUsage | null = null

    try {
      const providerIterator = provider.streamChat({ model: modelName, purpose: "agent_main", system, messages: providerMessages, tools: providerToolSchemas, thinking, maxTokens: maxTok })[Symbol.asyncIterator]()
      while (true) {
        const next = await nextProviderEvent(providerIterator, providerIdleTimeoutMs())
        if (next.done) break
        const event = next.value
        if (event.type === "text" && event.data) {
          textChunks.push(String(event.data))
          if (!bufferReadonlyText) yield event
        }
        else if (event.type === "thinking_blocks" && event.data) { thinkingBlocks = event.data as typeof thinkingBlocks }
        else if (event.type === "token_usage" && event.data) {
          providerUsage = mergeProviderTokenUsage(providerUsage, event.data as ProviderTokenUsage)
        }
        else if (event.type === "status") {
          options.runTrace?.record("provider_status", { round, status: event.data })
          yield event
        }
        else if (event.type === "tool_call" && event.data) {
          if (bufferReadonlyText && !bufferedTextEmitted && textChunks.length > 0) {
            yield { type: "text", data: textChunks.join("") }
            bufferedTextEmitted = true
          }
          completedToolCalls.push(event.data as typeof completedToolCalls[0]); yield event
        }
        else if (event.type === "error") {
          streamError = String(event.data ?? "")
          // Provider formats non-retryable errors as "auth ..." or "client ..."
          streamErrorRetryable = !isNonRetryableProviderStreamError(streamError)
          streamErrorYielded = true
          yield event
        }
      }
    } catch (e) {
      streamError = e instanceof Error ? e.message : String(e)
      const classified = classifyProviderError(e)
      streamErrorRetryable = classified.retryable
      yield { type: "error", data: streamError }
      streamErrorYielded = true
    }

    const roundMs = Date.now() - roundStart

    const finalText = textChunks.join("")
    options.runTrace?.record("round_output", {
      round,
      finalTextChars: finalText.length,
      textChunkCount: textChunks.length,
      completedToolCalls: completedToolCalls.length,
      streamError: streamError || undefined,
      bufferReadonlyText,
    })
    const providerRoundInputTokens = providerUsage
      ? (providerUsage.cacheReadInputTokens ?? 0) + (providerUsage.cacheMissInputTokens ?? providerUsage.inputTokens ?? 0)
      : undefined
    if (typeof providerRoundInputTokens === "number" && providerRoundInputTokens > 0) {
      contextInputTotal += providerRoundInputTokens - estimatedRoundInputTokens
    }

    const estimatedOutputTokens = Math.round(finalText.length / 3 + completedToolCalls.reduce((s, tc) => s + JSON.stringify(tc.input).length / 3, 0))
    contextOutputTotal += providerUsage?.outputTokens ?? estimatedOutputTokens
    const displayedCacheHitRate = providerUsage?.cacheHitRate ?? cacheTracker.hitRate
    const finalUsageEvent = {
        requestedModel: modelName,
        actualModel: providerUsage?.actualModel,
        inputTokens: contextInputTotal,
        outputTokens: contextOutputTotal,
        contextMax: CONTEXT_MAX,
        round,
        roundMs,
        cacheHitRate: displayedCacheHitRate,
        cacheStatus,
        cacheSource: providerUsage ? "provider" : "estimate",
        cacheReadInputTokens: providerUsage?.cacheReadInputTokens,
        cacheMissInputTokens: providerUsage?.cacheMissInputTokens,
        cacheCreationInputTokens: providerUsage?.cacheCreationInputTokens,
        cachePrefixShape: { firstChangedSection: cacheShape.firstChangedSection, sections: cacheShape.sections },
        contextUsagePercent: preRoundCtx.contextBudgetPercent,
        cacheAnatomy,
    }
    options.runTrace?.record("token_usage", finalUsageEvent)
    yield {
      type: "token_usage",
      data: finalUsageEvent,
    }

    if (streamError) {
      if (!streamErrorRetryable) {
        if (!streamErrorYielded) yield { type: "error", data: streamError }
        yield { type: "status", data: `provider-stream-gate: blocked (non-retryable: ${streamError.slice(0, 80)})` }
        options.runTrace?.record("gate_decision", {
          gate: "provider_stream",
          decision: "blocked",
          reason: "non_retryable",
          error: streamError,
        })
        break
      }

      if (taskTracker) {
        const missingAfterStreamFailure = missingTaskRequirements(taskTracker)
        if (round + 1 < maxRounds) {
          if (finalText.trim()) rawMessages.push({ role: "assistant", content: compactAssistantContext(finalText) })
          rawMessages.push({ role: "user", content: formatProviderStreamRecoveryPrompt({
            error: streamError,
            missing: missingAfterStreamFailure,
          }) })
          yield { type: "status", data: "provider-stream-gate: retrying unfinished long task" }
          options.runTrace?.record("gate_decision", {
            gate: "provider_stream",
            decision: "continue",
            error: streamError,
            missing: missingAfterStreamFailure,
          })
          continue
        }
        yield { type: "status", data: "provider-stream-gate: blocked unfinished long task" }
        yield { type: "text", data: formatProviderStreamBlockedReport({
          error: streamError,
          missing: missingAfterStreamFailure,
          changedFiles: [...taskFiles],
        }) }
        options.runTrace?.record("gate_decision", {
          gate: "provider_stream",
          decision: "blocked",
          error: streamError,
          missing: missingAfterStreamFailure,
        })
        break
      }

      if (round + 1 < maxRounds) {
        if (finalText.trim()) rawMessages.push({ role: "assistant", content: compactAssistantContext(finalText) })
        rawMessages.push({ role: "user", content: formatGenericProviderStreamRecoveryPrompt({ error: streamError }) })
        yield { type: "status", data: "provider-stream-gate: retrying interrupted round" }
        options.runTrace?.record("gate_decision", {
          gate: "provider_stream",
          decision: "continue",
          error: streamError,
        })
        continue
      }

      yield { type: "status", data: "provider-stream-gate: blocked interrupted round" }
      yield { type: "text", data: formatGenericProviderStreamBlockedReport({ error: streamError }) }
      options.runTrace?.record("gate_decision", {
        gate: "provider_stream",
        decision: "blocked",
        error: streamError,
      })
      break
    }

    if (completedToolCalls.length === 0 && finalText) {
      // ── Completion Orchestrator: unified final gate evaluation (PR-3.1) ──
      const orchestrator = new CompletionOrchestrator()
      const orchResult = await orchestrator.evaluate({
        round,
        finalText,
        intentPolicy,
        taskTracker,
        pendingRippleObligations,
        verificationResults: lastVerificationResults,
        changedFiles: [...taskFiles],
        taskHadWrite,
        taskToolErrors,
        taskModifiedFiles,
        lastTypecheck,
        lastRippleReports,
        planApproved,
        planningRejections,
        maxRounds,
        priorTools: lastToolNames,
        priorFiles: taskFiles,
        confidenceEvaluator,
        evidenceLedger,
        testimonyLedger,
        flashJudge,
        masterPlan: masterPlan ?? null,
        autoApprovePlan: options.autoApprovePlan ?? false,
        language,
        runTrace: options.runTrace,
        gateTelemetry,
        recentTurns: collectRecentTurns(rawMessages, 6),
        approvedPlanText: options.planText,
      })

      // Apply orchestrator side effects
      for (const msg of orchResult.injectMessages) {
        rawMessages.push(msg as ProviderMessage)
      }
      for (const s of orchResult.statusMessages) {
        yield { type: "status", data: s }
      }
      for (const t of orchResult.yieldTexts) {
        yield { type: "text", data: t }
      }
      for (const ev of orchResult.traceEvents) {
        options.runTrace?.record("gate_decision", ev)
      }
      if (orchResult.planningRejections !== undefined) {
        planningRejections = orchResult.planningRejections
      }

      // Handle plan auto-approve → activate master plan
      if (orchResult.activateMasterPlan) {
        const { planText, goal, forcePacket } = orchResult.activateMasterPlan
        if (activateMasterPlan(planText, goal, forcePacket)) {
          yield { type: "status", data: `master-plan: ${planProgress(masterPlan!)} nodes` }
        }
      }

      switch (orchResult.decision) {
        case "plan_ready":
          if (orchResult.breakEvent) {
            yield orchResult.breakEvent as { type: "plan_ready"; data: unknown }
          }
          break
        case "continue":
          continue
        case "break_blocked":
          break
        case "done": {
          // Try master plan node transition before final delivery
          if (orchResult.tryNodeTransition && masterPlan && tryNodeTransition()) {
            yield { type: "status", data: `master-plan: ${planProgress(masterPlan)} → next node activated` }
            options.runTrace?.record("gate_decision", { gate: "master_plan", decision: "next_node", progress: planProgress(masterPlan) })
            continue
          }
          if (masterPlan) {
            yield { type: "status", data: "master-plan: all nodes complete" }
            options.runTrace?.record("gate_decision", { gate: "master_plan", decision: "plan_complete" })
          }
          if (bufferReadonlyText && !bufferedTextEmitted) {
            yield { type: "text", data: finalText }
          }
          break
        }
      }
      break
    }
    if (completedToolCalls.length === 0) {
      yield { type: "status", data: "empty-round: no tool calls or final text" }
      break
    }

    const assistantContent: Array<Record<string, unknown>> = []
    for (const tb of thinkingBlocks) assistantContent.push({ type: "thinking", thinking: tb.thinking, signature: tb.signature })
    if (finalText) assistantContent.push({ type: "text", text: finalText })
    for (const tc of completedToolCalls) assistantContent.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input })
    rawMessages.push({ role: "assistant", content: assistantContent })

    // ── Persist thinking chain ──
    if (options.thinkingStore && thinkingBlocks.length > 0) {
      thinkingTokenTotal += thinkingBlocks.reduce((sum, tb) => sum + Math.round(tb.thinking.length / 3), 0)
      options.thinkingStore.storeThinking({
        query: effectivePrompt,
        thinkingBlocks,
        roundNum: round,
        filePattern: [...taskFiles].join(","),
        tags: [
          ...(state.hadError ? ["error"] : []),
          intentPolicy.mode,
          `round-${round}`,
        ],
        toolContext: completedToolCalls.map(tc => tc.name),
      })
    }

    // ── Execute tools + self-learn tracking ──
    const toolNames: string[] = []
    const filePaths: string[] = []
    const resultsContent: Array<Record<string, unknown>> = []
    const learnPrompts: string[] = []
    const modifiedFilesThisRound = new Set<string>()
    const rippleReportsThisRound: RippleReport[] = []
    const verificationResultsThisRound: VerificationResult[] = []
    let roundHadToolError = false
    let completionGateText = ""
    let verificationPassedThisRound = false
    let serviceTestGuidanceNeeded = false
    rateLimitShell = 0; rateLimitFile = 0; rateLimitNetwork = 0

    const parallelReadonly = completedToolCalls.length > 1 && completedToolCalls.every(tc => {
      const tool = tools.find(t => t.defn.name === tc.name)
      return Boolean(tc.name !== "web_search" && tool && tool.defn.isReadonly && !tool.executeStream && (tool.defn.isConcurrencySafe ?? true))
    })
    const parallelResults = new Map<string, { content: string; success: boolean; metadata?: Record<string, unknown>; startedAt: number }>()
    if (parallelReadonly) {
      yield { type: "status", data: `greedy-tools: ${completedToolCalls.length} readonly calls` }
      const results = await Promise.all(completedToolCalls.map(async tc => {
        const tool = tools.find(t => t.defn.name === tc.name)!
        const startedAt = Date.now()
        try {
          const result = await executeToolWithHooks({
            hooks,
            tool,
            params: tc.input,
            execute: (_params) => withToolTimeout(tc.name, tool.execute(_params)),
          })
          return { id: tc.id, content: result.content, success: result.success, metadata: result.metadata, startedAt }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          return { id: tc.id, content: message, success: false, metadata: undefined, startedAt }
        }
      }))
      for (const result of results) parallelResults.set(result.id, result)
    }

    for (const tc of completedToolCalls) {
      toolNames.push(tc.name)
      options.runTrace?.record("tool_call", { round, id: tc.id, tool: tc.name, input: tc.input })
      const tool = tools.find(t => t.defn.name === tc.name)
      let resultContent = "Unknown tool"
      let resultObj: { success: boolean; content: string; metadata?: Record<string, unknown> } = { success: false, content: "" }
      let toolStartedAt = Date.now()

      if (preRoundCtx.taskPlanning && round > 0) {
        resultContent = `任务追踪已阻止：当前是计划专用回合，只允许输出计划，不允许调用 ${tc.name}。下一轮将进入执行阶段。`
        resultObj = { success: false, content: resultContent, metadata: { blocked: true, planOnlyRound: true } }
        resultsContent.push({ type: "tool_result", tool_use_id: tc.id, content: resultContent.slice(0, 4000) })
        continue
      }

      // ── Unified tool execution policy — all gates in one pure function ──
      const policyResult = evaluateToolPolicy({
        toolCall: { id: tc.id, name: tc.name, input: tc.input },
        tool,
        intentPolicy,
        taskTracker,
        rippleBlockActive,
        pendingRippleObligations,
        permissionGate,
        permissionMode: pmode,
        rateLimits: { safe: 0, shell: rateLimitShell, file: rateLimitFile, network: rateLimitNetwork, git: 0 },
        webSearchFailedThisTurn,
        webSearchFailReason,
        finalText,
        contextReadinessBlocked,
        contextReadinessBlockers,
        modeContract: getActiveMode(),
      })

      // ── Gate telemetry for tool policy gates ──
      // PR-7.1: layer-prefixed names for per-layer breakdown
      const toolGateNames = ["policy:rate_limit", "policy:permission", "policy:readonly_intent", "policy:ripple_block", "policy:planning_phase", "policy:context_readiness", "policy:web_search_failed", "policy:mode_contract", "policy:tool_risk"]
      const blockedGate = policyResult.allowed ? null
        : policyResult.reason.startsWith("permission") ? "policy:permission"
        : policyResult.reason.startsWith("tool_risk") ? "policy:tool_risk"
        : `policy:${policyResult.reason}`
      for (const gn of toolGateNames) {
        if (gn === blockedGate) { gateTelemetry.record(gn, "block"); break }
        gateTelemetry.record(gn, "pass")
      }

      // Track rate limits regardless of outcome
      if (policyResult.incrementRateLimit === "shell") rateLimitShell++
      else if (policyResult.incrementRateLimit === "file") rateLimitFile++
      else if (policyResult.incrementRateLimit === "network") rateLimitNetwork++

      if (!policyResult.allowed) {
        resultContent = policyResult.blockMessage
        resultObj = { success: false, content: resultContent }
        // Hard blocks (rate_limit, permission:deny) push immediately and skip yield.
        // Soft blocks (readonly, ripple, planning, web_search) fall through to yield.
        if (policyResult.reason === "rate_limit" || policyResult.reason.startsWith("permission:")) {
          resultsContent.push({ type: "tool_result", tool_use_id: tc.id, content: resultContent.slice(0, 4000) })
          continue
        }
      }

      if (tool && policyResult.allowed) {
        const parallelResult = parallelResults.get(tc.id)
        // Use streaming variant if available (shell, long-running commands)
        if (parallelResult) {
          resultContent = parallelResult.content
          resultObj = { success: parallelResult.success, content: parallelResult.content, metadata: parallelResult.metadata }
          toolStartedAt = parallelResult.startedAt
        } else if (tool.executeStream) {
          try {
            const before = await runToolBeforeHook(hooks, tc.name, tc.input)
            if (before.blocked) {
              resultObj = appendHookWarnings(before.blocked, before.warnings)
              resultContent = resultObj.content
            } else {
              const effectiveParams = before.replaceParams ?? tc.input
              for await (const ev of tool.executeStream(effectiveParams)) {
                if (ev.type === "progress") {
                  // Raw shell stdout/stderr is often noisy progress output.
                  // Keep it out of the spinner/status line; the final result
                  // still carries command output for diagnostics.
                  continue
                } else if (ev.type === "done") {
                  const rawResult = ev.data
                  const after = await runToolAfterHook(hooks, tc.name, effectiveParams, rawResult)
                  const finalResult = appendHookWarnings(after.result, [...before.warnings, ...after.warnings])
                  resultContent = finalResult.content
                  resultObj = { success: finalResult.success, content: finalResult.content, metadata: finalResult.metadata }
                }
              }
            }
          } catch (e) {
            resultContent = e instanceof Error ? e.message : String(e)
            resultObj = { success: false, content: resultContent }
          }
        } else {
          try {
            const result = await executeToolWithHooks({
              hooks,
              tool,
              params: tc.input,
              execute: (_params) => withToolTimeout(tc.name, tool.execute(_params)),
            })
            resultContent = result.content
            resultObj = { success: result.success, content: result.content, metadata: result.metadata }
          } catch (e) {
            resultContent = e instanceof Error ? e.message : String(e)
            resultObj = { success: false, content: resultContent }
          }
        }
      }
        const changedFilesForLedger = new Set<string>()
        // ── Smart truncation: head+tail with error-aware allocation ──
        if (resultObj.success && resultContent.length > 1400) {
          const lines = resultContent.split("\n")
          const totalBytes = Buffer.byteLength(resultContent, "utf-8")
          const MAX_LINES = 60; const MAX_BYTES = 12000
          if (lines.length > MAX_LINES || totalBytes > MAX_BYTES) {
            const tailScan = resultContent.slice(-2048)
            const hasErrors = /error|exception|failed|fatal|traceback|panic|exit code|Error|FAIL/i.test(tailScan)
            const headPct = hasErrors ? 0.7 : 0.85
            const headMaxLines = Math.floor(MAX_LINES * headPct)
            const tailMaxLines = MAX_LINES - headMaxLines
            const head = lines.slice(0, headMaxLines)
            const tail = lines.slice(-tailMaxLines)
            const omitted = lines.length - head.length - tail.length
            const marker = hasErrors
              ? `\n... [${omitted} lines trimmed — errors detected in tail] ...\n`
              : `\n... [${omitted} lines trimmed] ...\n`
            resultContent = head.join("\n") + marker + tail.join("\n")
          }
        }

        yield { type: "tool_result", data: { name: tc.name, content: resultContent.slice(0, 500) } }
        if (tc.name === "web_search" && !resultObj.success) {
          webSearchFailedThisTurn = true
          webSearchFailReason = resultContent.slice(0, 200)
        }
        if (tc.name === "request_deeper_thinking" && resultObj.success) {
          requestedMaxThinking = true
          yield { type: "status", data: "深度思考: 模型请求升级到 max 32K" }
        }

        // Self-learn: detect repeated errors
        if (!resultObj.success || /[ef]ail|[ef]rr|blocked|not found|denied/i.test(resultContent)) {
          roundHadToolError = true
          taskToolErrors += 1
          consecutiveErrors += 1
          const learnPrompt = errorTracker.record(tc.name, resultContent)
          if (learnPrompt) learnPrompts.push(learnPrompt)
        } else {
          consecutiveErrors = 0
        }
        if (containsTypecheckFailure(resultContent)) {
          lastTypecheck = {
            passed: isVerificationUnavailable(resultContent),
            issues: countTypecheckIssues(resultContent),
            output: resultContent.slice(0, 1000),
          }
        } else if (tc.name === "shell" && /\btsc\b|typescript|typecheck/i.test(String(tc.input.command ?? "")) && !resultObj.success) {
          const unavailable = isVerificationUnavailable(resultContent)
          lastTypecheck = {
            passed: unavailable,
            issues: unavailable ? 0 : 1,
            output: resultContent.slice(0, 1000),
          }
        }
        const verification = resultObj.metadata?.verification as VerificationResult | undefined
        if (verification) {
          verificationResultsThisRound.push(verification)
          options.runTrace?.record("verification_result", verification)
          if (verification.kind === "typecheck") {
            lastTypecheck = {
              passed: verification.passed,
              issues: verification.issues,
              output: verification.summary,
            }
          }
          if (verification.passed) verificationPassedThisRound = true
          if (!verification.passed && verification.kind === "test" && hasServiceTestFailure(resultContent)) {
            serviceTestGuidanceNeeded = true
          }
        }

        const path = tc.input.path as string | undefined
        if (path) {
          filePaths.push(path)
          taskFiles.add(normalizeProjectPath(path))
          const isWriteTool = tc.name === "write_file" || tc.name === "edit_file" || tc.name === "edit_fim"
          if (resultObj.success && isWriteTool) {
            const normalizedPath = normalizeProjectPath(path)
            modifiedFilesThisRound.add(normalizedPath)
            changedFilesForLedger.add(normalizedPath)
            taskHadWrite = true
            taskModifiedFiles += 1
          }
          const rippleReport = resultObj.metadata?.rippleReport as RippleReport | undefined
          if (resultObj.success && rippleReport) {
            rippleReportsThisRound.push(rippleReport)
            modifiedFilesThisRound.add(normalizeProjectPath(rippleReport.targetFile))
          }
          if (stagedContext) {
            if (tc.name === "read_file") stagedContext.markLoaded(path)
            else if (tc.name === "write_file" || tc.name === "edit_file" || tc.name === "edit_fim") {
              stagedContext.markEdited(path)
              runPostEditDiagnostics(path, resultObj)
            }
          }
          if (options.thinkingStore && (tc.name === "shell" || tc.name === "edit_fim" || tc.name === "write_file")) {
            options.thinkingStore.store(prompt, `Tool: ${tc.name}\nResult: ${resultContent.slice(0, 500)}`, resultContent.includes("error") || resultContent.includes("Error") ? "fix" : "implement")
          }
        }

        if (resultObj.success && Array.isArray(resultObj.metadata?.paths)) {
          for (const path of resultObj.metadata.paths) {
            if (typeof path === "string") {
              filePaths.push(path)
              const normalized = normalizeProjectPath(path)
              modifiedFilesThisRound.add(normalized)
              changedFilesForLedger.add(normalized)
              taskFiles.add(normalized)
              taskHadWrite = true
              taskModifiedFiles += 1
              if (stagedContext) stagedContext.markEdited(path)
            }
          }
        }
        if (resultObj.success && Array.isArray(resultObj.metadata?.rippleReports)) {
          for (const report of resultObj.metadata.rippleReports) {
            rippleReportsThisRound.push(report as RippleReport)
            const normalized = normalizeProjectPath((report as RippleReport).targetFile)
            modifiedFilesThisRound.add(normalized)
            changedFilesForLedger.add(normalized)
          }
        }

        const ledgerEntry = toolLedger.record({
          id: tc.id,
          round,
          tool: tc.name,
          startedAt: toolStartedAt,
          result: resultObj,
          changedFiles: [...changedFilesForLedger],
        })
        options.runTrace?.record("tool_result", ledgerEntry)
        yield { type: "status", data: formatToolLedgerStatus(ledgerEntry) }

      resultsContent.push({ type: "tool_result", tool_use_id: tc.id, content: resultContent.slice(0, 4000) })
    }

    // ── Microcompact: forward pass — compact fresh tool results before they enter history ──
    // PR 4: use epoch compress threshold in addition to legacy heuristics
    const shouldMicrocompact = preRoundCtx.contextBudgetPercent >= 35
      || rawMessages.length >= 40
      || epochAction === "compress"
      || epochAction === "forceCompress"
      || epochAction === "rollover"
    if (shouldMicrocompact) {
      const mcResult = microcompactToolResults(resultsContent, completedToolCalls)
      while (resultsContent.length > 0) resultsContent.pop()
      for (const r of mcResult.results) resultsContent.push(r)
      if (mcResult.compacted > 0) {
        microcompactCount += mcResult.compacted
        yield { type: "status", data: `microcompact: ${mcResult.compacted} tool results compacted (${microcompactCount} total)` }
      }
    }

    let postToolRequiredFilesPrompt = ""
    let postToolPlanningPrompt = ""
    if (modifiedFilesThisRound.size > 0 || rippleReportsThisRound.length > 0) {
      const rippleVerification = runRippleVerification(modifiedFilesThisRound)
      const hadTsWriteThisRound = [...modifiedFilesThisRound].some(path => path.endsWith(".ts") || path.endsWith(".tsx"))
      if (rippleVerification.passed) {
        pendingRippleObligations = resolveObligations(pendingRippleObligations, modifiedFilesThisRound)
        if (!lastTypecheck || lastTypecheck.passed) lastTypecheck = { passed: true, issues: 0 }
      } else if (modifiedFilesThisRound.size > 0 && rippleVerification.available) {
        lastTypecheck = { passed: false, issues: rippleVerification.issues, output: rippleVerification.output || "ripple verification failed" }
        yield { type: "status", data: "ripple-verification: failed; obligations retained" }
      } else if (modifiedFilesThisRound.size > 0) {
        lastTypecheck = { passed: true, issues: 0, output: rippleVerification.output || "tsc unavailable" }
        yield { type: "status", data: "ripple-verification: skipped; tsc unavailable" }
      }
      for (const report of rippleReportsThisRound) {
        pendingRippleObligations = mergeObligations(
          pendingRippleObligations,
          obligationsFromReport(report, modifiedFilesThisRound),
        )
      }
      if (pendingRippleObligations.length > 0) {
        // Let ripple engine know agent is cascading — promotes block→warn
        setCascadeFiles(new Set(pendingRippleObligations.map(o => o.targetFile)))
        yield { type: "status", data: `ripple-obligations: pending ${pendingRippleObligations.length}` }
        options.runTrace?.record("gate_decision", { gate: "ripple_obligations", decision: "continue", pending: pendingRippleObligations.length })
      } else {
        setCascadeFiles(new Set())
      }
      const missingNarrowFiles = intentPolicy.mode === "narrow_edit"
        ? missingExplicitRequiredFiles(effectivePrompt, modifiedFilesThisRound)
        : []
      // PR-3.1: narrow edit auto-complete extracted to CompletionOrchestrator helper
      const narrowResult = checkNarrowEditCompletion({
        autoFinishOnVerifiedWrite: options.autoFinishOnVerifiedWrite,
        intentMode: intentPolicy.mode,
        hadTsWriteThisRound,
        blockingObligations: getBlockingObligations(pendingRippleObligations).length,
        lastTypecheckPassed: lastTypecheck?.passed,
        missingNarrowFiles,
        modifiedFilesThisRound,
      })
      if (narrowResult.completionText) {
        completionGateText = narrowResult.completionText
      } else if (narrowResult.missingFilesPrompt) {
        postToolRequiredFilesPrompt = narrowResult.missingFilesPrompt
        if (narrowResult.missingFilesStatus) {
          yield { type: "status", data: narrowResult.missingFilesStatus }
        }
        options.runTrace?.record("gate_decision", { gate: "explicit_required_files", decision: "continue", missing: missingNarrowFiles })
      }
    }
    if (rippleReportsThisRound.length > 0) lastRippleReports = rippleReportsThisRound

    // ── Gate overflow: track cumulative blocks, force strategy switch at 3, BLOCKED at 5 ──
    sandbox.clearBlockedFiles()

    const overflowResult = processGateOverflow({
      round,
      rippleBlockActive,
      pendingRippleObligationsLength: getBlockingObligations(pendingRippleObligations).length,
      postToolPlanningPrompt,
      postToolRequiredFilesPrompt,
      gateBlockCounts,
    })
    for (const msg of overflowResult.deferredMessages) deferredGateMessages.push(msg)
    for (const ev of overflowResult.statusEvents) yield { type: "status", data: ev }

    if (overflowResult.blocked) {
      const reason = `${overflowResult.blockedGate} 累积阻断 ${overflowResult.blockedCount} 次，请求人工介入。`
      sm.transition(AgentState.BLOCKED, reason)
      yield { type: "status", data: `gate-overflow: ${overflowResult.blockedGate} blocked ${overflowResult.blockedCount} times — BLOCKED` }
      options.runTrace?.record("agent_loop_blocked", { reason, gate: overflowResult.blockedGate, blockCount: overflowResult.blockedCount })
      setRuntimeContextBudgetMode("normal")
      sandbox.dispose()
      setShellSandbox(null)
      await flushTelemetry()
      return
    }

    // ── Revise plan: stuck detection → push back to planning ──
    if (
      taskTracker &&
      taskTracker.phase === "building" &&
      completedToolCalls.length === 0 &&
      modifiedFilesThisRound.size === 0 &&
      verificationResultsThisRound.length === 0 &&
      (consecutiveErrors >= 3 || !taskTracker.steps.some(s => s.status === "done"))
    ) {
      // Only use singleton revisePlan when MasterPlan is not active.
      // MasterPlan-level revisePlan (with frozen nodes) is deferred to PR 2.
      if (!masterPlan) {
      const reason = consecutiveErrors >= 3
        ? `连续 ${consecutiveErrors} 次工具错误`
        : "步骤未推进，当前方案可能有问题"
      const reviseMsg = revisePlan(taskTracker, reason)
      deferredGateMessages.push(reviseMsg)
      yield { type: "status", data: `revise-plan: ${reason}` }
      options.runTrace?.record("gate_decision", { gate: "revise_plan", decision: "replan", reason })
      } // if (!masterPlan)
    }

    if (taskTracker?.phase === "planning" && finalText.trim()) {
      // User already confirmed → skip gate, accept directly
      if (planApproved) {
        markPlanAccepted(taskTracker)
        if ((options.planText ?? lastPlanText) && activateMasterPlan(options.planText ?? lastPlanText, taskTracker.goal)) {
          yield { type: "status", data: `master-plan: ${planProgress(masterPlan!)} nodes` }
        }
        yield { type: "status", data: "任务追踪: 用户已确认规划，进入执行阶段" }
        planApproved = false
      } else {
        const planningGate = evaluatePlanningArtifact(finalText, taskTracker)
        if (planningGate.ok) {
          markPlanAccepted(taskTracker)
          if (activateMasterPlan(finalText, taskTracker.goal)) {
            yield { type: "status", data: `master-plan: ${planProgress(masterPlan!)} nodes` }
          }
          yield { type: "status", data: "任务追踪: 已读取计划，进入执行阶段" }
          options.runTrace?.record("gate_decision", {
            gate: "planning",
            decision: "accepted",
            score: planningGate.score,
            signals: planningGate.signals,
          })
        } else if (round + 1 < maxRounds) {
          postToolPlanningPrompt = formatPlanningGatePrompt(planningGate, taskTracker)
          yield { type: "status", data: `planning-gate: revise plan (${planningGate.missing.length} missing)` }
          options.runTrace?.record("gate_decision", {
            gate: "planning",
            decision: "revise",
            missing: planningGate.missing,
            score: planningGate.score,
          })
        }
      }
    }

    // ── Batch typecheck: run tsc once per round instead of per-file ──
    const tsFilesWritten = [...modifiedFilesThisRound].filter(f => f.endsWith(".ts") || f.endsWith(".tsx"))
    if (tsFilesWritten.length > 0) {
      const tscResult = runTypeScriptNoEmit(process.cwd())
      lastTypecheck = tscResult.available
        ? { passed: tscResult.passed, issues: tscResult.issues, output: tscResult.output }
        : { passed: true, issues: 0, output: tscResult.output || "tsc unavailable" }
      if (!tscResult.passed && tscResult.available) {
        const diagLines = tscResult.output
          .split("\n")
          .filter(l => tsFilesWritten.some(f => l.includes(f)))
          .join("\n")
        if (diagLines) {
          const lastResult = resultsContent[resultsContent.length - 1]
          if (lastResult) {
            lastResult.content = String(lastResult.content) + `\n\n[post-round typecheck — fix in next round]\n${diagLines}`
          }
        }
      }
    }

    updateTaskTrackerAfterTools({
      tracker: taskTracker,
      changedFiles: [...modifiedFilesThisRound],
      toolNames,
      typecheckPassed: lastTypecheck?.passed,
      verificationPassed: verificationPassedThisRound,
      verificationResults: verificationResultsThisRound,
      skipLegacyStepIds: !!masterPlan,
      evidenceLedger,
    })
    if (taskTracker) {
      const status = formatTaskTrackerStatus(taskTracker)
      if (status) yield { type: "status", data: status }
      yield { type: "task_progress", data: snapshotTaskTracker(taskTracker) }
    }
    if (verificationResultsThisRound.length > 0) {
      lastVerificationResults = [...lastVerificationResults, ...verificationResultsThisRound].slice(-20)
    }
    // ── Inject gate overflow / revisePlan messages BEFORE tool results ──
    // Must go as CONTENT BLOCKS in the same user message as tool_results,
    // NOT as separate user messages (breaks Anthropic format: tool_use→tool_result adjacency).
    if (deferredGateMessages.length > 0) {
      for (const msg of deferredGateMessages) {
        resultsContent.unshift({ type: "text", text: msg + "\n" })
      }
      deferredGateMessages.length = 0
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
      if (!resultsContent.some(r => isRecord(r) && r.type === "tool_result" && r.tool_use_id === tc.id)) {
        resultsContent.push({ type: "tool_result", tool_use_id: tc.id, content: "(skipped)", is_error: true })
      }
    }
    rawMessages.push({ role: "user", content: resultsContent })

    // ── Microcompact: retrospective pass — compact historical tool results every 10 rounds, or on epoch force-compress ──
    if (round >= 15 && round % 10 === 0 || epochAction === "forceCompress" || epochAction === "rollover") {
      const histCompacted = compactHistoricalToolResults(rawMessages, 8)
      if (histCompacted > 0) {
        microcompactCount += histCompacted
        yield { type: "status", data: `microcompact: ${histCompacted} historical results compacted (${microcompactCount} total)` }
      }
    }

    // ── State machine transition (after tool results, before next round) ──
    updateStateMachine(sm, {
      roundHadToolError,
      hadSearchTool: toolNames.some(t => /read_file|web_search|find_symbol|find_references|project_structure|glob|grep/.test(t)),
      hadWriteTool: toolNames.some(t => /write_file|edit_file|edit_fim/.test(t)),
      hadVerifyTool: toolNames.some(t => t === "shell" || t === "typescript"),
      isDone: round + 1 >= maxRounds || false,
      pendingRippleCount: pendingRippleObligations.length,
    })
    // Reset one-shot thinking upgrade
    if (requestedMaxThinking) requestedMaxThinking = false

    // ── Thinking compaction (one-shot per session, triggered by epoch force-compress or 40% budget) ──
    if (
      !thinkingCompacted &&
      preRoundCtx.contextBudgetMode === "normal" &&
      (preRoundCtx.contextBudgetPercent >= 40 || epochAction === "forceCompress" || epochAction === "rollover") &&
      options.thinkingStore
    ) {
      const thinkingRounds = collectThinkingRounds(rawMessages)
      if (thinkingRounds.length >= 2) {
        if (shouldSkipProviderPurpose("thinking_compaction")) {
          yield { type: "status", data: formatSkippedProviderPurpose("thinking_compaction") }
          options.runTrace?.record("gate_decision", { gate: "cost_mode", decision: "skip", purpose: "thinking_compaction" })
        } else {
        yield { type: "status", data: `thinking-compaction: ${thinkingRounds.length} rounds → analyzing...` }
        try {
          const compactResult = await compactThinkingChain(
            thinkingRounds,
            async function* (system, prompt) {
              for await (const ev of provider.streamChat({
                model: options.modelRouter?.selectForPurpose("thinking_compaction") ?? "deepseek-v4-flash",
                purpose: "thinking_compaction",
                system,
                messages: [{ role: "user", content: prompt }],
                maxTokens: 1024,
              })) {
                yield ev
              }
            },
          )
          if (compactResult.success) {
            const mergeResult = options.thinkingStore!.mergeCompressedInsights(
              options.stableMemoryContext ?? "",
              compactResult.output,
            )
            const insightCount = compactResult.output.key_insights.length +
              compactResult.output.discarded.length +
              compactResult.output.verified.length +
              compactResult.output.open.length

            if (mergeResult.changed) {
              // Inject updated cold memory as a user message — does NOT
              // mutate rawMessages or invalidate the frozen stable prefix.
              // Prefix cache continuity is preserved (system+tools+stable_prefix
              // remain byte-identical; only a new user message is appended).
              const compactSummary = [
                "<system-reminder>",
                "思考链已压实。以下是从本次会话推理中提取的关键洞察（已去重并存入冷记忆）：",
                ...compactResult.output.key_insights.map((k, i) => `${i + 1}. [insight] ${k}`),
                ...compactResult.output.verified.map((v, i) => `✓ [verified] ${v}`),
                ...compactResult.output.open.map((o, i) => `? [open] ${o}`),
                "</system-reminder>",
              ].join("\n")
              rawMessages.push({ role: "user", content: compactSummary })
              options.stableMemoryContext = mergeResult.merged
              // NOTE: frozenStablePrefix is NOT invalidated. The next round's
              // cold memory diff is carried as a volatile message, preserving
              // the system+tools+stable_prefix cache boundary.
              yield { type: "status", data: `thinking-compaction: ${thinkingRounds.length} rounds → ${insightCount} insights (appended, cache preserved)` }
            }

            options.thinkingStore!.storeCompressed({
              query: effectivePrompt,
              compactOutput: compactResult.output,
              roundRange: `r${thinkingRounds[0]?.roundNum ?? 0}-r${thinkingRounds[thinkingRounds.length - 1]?.roundNum ?? round}`,
              filePattern: [...taskFiles].join(","),
            })
            thinkingCompacted = true
            yield { type: "status", data: `thinking-compaction: ${thinkingRounds.length} rounds → ${insightCount} insights` }
          }
        } catch {
          yield { type: "status", data: "thinking-compaction: failed, keeping full chains" }
        }
        }
      }
    }

    // ── Historical Context injection (L3 volatile, semantic recall) ──
    if (options.thinkingStore && round > 0 && state.roundNum % 3 === 0) {
      if (shouldSkipProviderPurpose("semantic_recall_score")) {
        yield { type: "status", data: formatSkippedProviderPurpose("semantic_recall_score") }
        options.runTrace?.record("gate_decision", { gate: "cost_mode", decision: "skip", purpose: "semantic_recall_score" })
      } else {
      try {
        const semanticRecords = await options.thinkingStore.findSimilarSemantic(
          effectivePrompt,
          async (query, candidates) => {
            const lines = candidates.map((c, i) => `候选${i + 1}: ${c.queryPreview.slice(0, 80)}`).join("\n")
            const prompt = `当前问题: "${query.slice(0, 120)}"\n\n对以下每个候选与当前问题的相关性从0-10打分，只输出逗号分隔的数字:\n${lines}\n\n输出格式: 8,3,9,1,6,...`
            const scores: number[] = []
            try {
              for await (const ev of provider.streamChat({
                model: options.modelRouter?.selectForPurpose("semantic_recall_score") ?? "deepseek-v4-flash",
                purpose: "semantic_recall_score",
                system: "你是相关性打分器。只输出数字。",
                messages: [{ role: "user", content: prompt }],
                maxTokens: 128,
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
          const historicalContext = options.thinkingStore.formatForVolatileContext(semanticRecords)
          if (historicalContext) {
            // Inject as an additional user message before the next round
            // This goes into L3 volatile — does NOT affect prefix cache
            rawMessages.push({ role: "user", content: historicalContext })
          }
        }
      } catch { /* semantic recall is best-effort */ }
      }
    }
    updateState(state, toolNames, filePaths, streamError !== "" || roundHadToolError)
    lastToolNames = toolNames
    if (postToolPlanningPrompt) {
      rawMessages.push({ role: "user", content: postToolPlanningPrompt })
      continue
    }

    const runtimeFilesThisRound = [...modifiedFilesThisRound].filter(path => isRuntimeSourceFile(path))
    if (runtimeFilesThisRound.length > 0) {
      runtimeSelfEditFiles = new Set([...runtimeSelfEditFiles, ...runtimeFilesThisRound])
    }
    if (runtimeSelfEditFiles.size > 0) {
      if (rootRuntimeVerificationPassed(verificationResultsThisRound) || rootRuntimeVerificationPassed(lastVerificationResults)) {
        const files = [...runtimeSelfEditFiles].sort().join(", ")
        yield { type: "status", data: "runtime-self-edit-gate: verified; restart required" }
        yield {
          type: "text",
          data: `Runtime source changes were verified, but the current DeepSeek Code process cannot hot-load them. Restart DeepSeek Code before continuing. Changed runtime files: ${files}.`,
        }
        options.runTrace?.record("gate_decision", { gate: "runtime_self_edit", decision: "restart_required", files: [...runtimeSelfEditFiles].sort() })
        break
      }
      if (round + 1 < maxRounds) {
        rawMessages.push({ role: "user", content: formatRuntimeSelfEditGate([...runtimeSelfEditFiles].sort()) })
        yield { type: "status", data: "runtime-self-edit-gate: run root typecheck then stop" }
        options.runTrace?.record("gate_decision", { gate: "runtime_self_edit", decision: "verify_then_restart", files: [...runtimeSelfEditFiles].sort() })
        continue
      }
    }

    if (serviceTestGuidanceNeeded) {
      rawMessages.push({ role: "user", content: formatServiceTestGuidance() })
      yield { type: "status", data: "服务型测试: 要求改为测试内启动并关闭服务" }
      options.runTrace?.record("gate_decision", { gate: "service_test", decision: "repair_guidance" })
    }

    const missingLongTask = missingTaskRequirements(taskTracker)
    if (taskTracker?.phase === "planning" && missingLongTask.length > 0 && round + 1 < maxRounds) {
      rawMessages.push({ role: "user", content: formatTaskPlanningPrompt(taskTracker, round + 1) })
      yield { type: "status", data: "任务追踪: 等待计划文本，下一轮不允许调用工具" }
      options.runTrace?.record("gate_decision", { gate: "semantic:task_tracker", decision: "plan_required", missing: missingLongTask })
      continue
    }
    if (taskTracker && missingLongTask.length > 0) {
      rawMessages.push({ role: "user", content: [
        "## 任务追踪未完成",
        "继续执行。尚未完成：",
        ...missingLongTask.slice(0, 12).map(item => `- ${item}`),
        "",
        "下一轮必须处理第一个未完成项，并在完成后运行验证。",
      ].join("\n") })
      yield { type: "status", data: `任务追踪: 阻止结束，剩余 ${missingLongTask.length} 项` }
      options.runTrace?.record("gate_decision", { gate: "semantic:task_tracker", decision: "continue", missing: missingLongTask })
    } else if (completionGateText) {
      // PR-3.1: narrow_edit auto-complete must pass evidence gate before breaking
      if (evidenceLedger && taskTracker) {
        const evidenceResult = canClaimDone({ tracker: taskTracker, evidence: evidenceLedger })
        if (!evidenceResult.canClaim) {
          rawMessages.push({ role: "user", content: [
            "## 完成被阻止 — 验证证据不足",
            ...evidenceResult.blocked.map(b => `- **${b}**`),
            "",
            "### 缺失项",
            ...evidenceResult.missing.map(m => `- ${m}`),
          ].join("\n") })
          yield { type: "status", data: `evidence-gate: narrow_edit blocked (${evidenceResult.missing.length} missing)` }
          options.runTrace?.record("gate_decision", { gate: "evidence", decision: "continue", missing: evidenceResult.missing })
          completionGateText = ""
          continue
        }
      }
      yield { type: "status", data: "completion-gate: verified write; stopping without extra provider round" }
      yield { type: "text", data: completionGateText }
      options.runTrace?.record("gate_decision", { gate: "completion", decision: "verified_write_stop" })
      break
    }

    if (stagedContext && completedToolCalls.length && finalText) {
      stagedContext.addSummary(finalText.slice(0, 120))
      stagedContext.advance()
    }

    // ── Checkpoint (adaptive density) ──
    const metrics: ComplexityMetrics = {
      filesPerRound: round > 0 ? taskModifiedFiles / round : 0,
      errorRate: round > 0 ? taskToolErrors / round : 0,
      round,
    }
    const cpDecision = adaptiveCheckpointThreshold(preRoundCtx.contextBudgetPercent, metrics)
    if (cpDecision && !shouldSkipCheckpointThisRound(round)) {
      yield { type: "status", data: `checkpoint: ${cpDecision.label} (${cpDecision.urgency})` }
      saveCheckpoint({
        version: 1,
        checkpointId: generateCheckpointId(),
        round,
        timestamp: Date.now(),
        sessionId: process.env.DEEPSEEK_SESSION_ID ?? "ds-default",
        masterPlan: planRef.current ? {
          goal: planRef.current.goal,
          nodes: planRef.current.nodes.map(n => ({ id: n.id, title: n.title, status: n.status })),
          current: planRef.current.current,
          progress: planProgress(planRef.current),
        } : (taskTracker ? { goal: taskTracker.goal, steps: taskTracker.steps.map(s => ({ id: s.id, status: s.status, title: s.title })) } : {}),
        taskSteps: taskTracker?.steps.map(s => ({ id: s.id, status: s.status, title: s.title })) ?? [],
        changedFiles: [...taskFiles],
        fileSHAs: {},
        coldMemorySHA: stablePrefixHash,
        knowledgeCount: 0,
        lastVerification: lastTypecheck ? { kind: "typecheck", passed: lastTypecheck.passed, command: "tsc --noEmit" } : null,
        conversationTokens: preRoundCtx.contextBudgetPercent > 0 ? Math.round(preRoundCtx.contextBudgetPercent * 1000) : 0,
        prevRound: round,
        summary: formatCheckpointSummary({
          version: 1, checkpointId: generateCheckpointId(), round, timestamp: Date.now(), sessionId: "",
          masterPlan: taskTracker ? { goal: taskTracker.goal, steps: taskTracker.steps } : {},
          taskSteps: taskTracker?.steps ?? [],
          changedFiles: [...taskFiles],
          fileSHAs: {},
          coldMemorySHA: stablePrefixHash,
          knowledgeCount: 0,
          lastVerification: lastTypecheck ? { kind: "typecheck", passed: lastTypecheck.passed, command: "tsc --noEmit" } : null,
          conversationTokens: Math.round(preRoundCtx.contextBudgetPercent * 1000),
          prevRound: round,
          summary: masterPlan
            ? `Round ${round}: ${planProgress(masterPlan)}, ${taskModifiedFiles} files, ${taskToolErrors} errors`
            : `Round ${round}: ${taskModifiedFiles} files, ${taskToolErrors} errors`,
        }),
      })
      recordCheckpointTaken(round)
      options.runTrace?.record("checkpoint", { label: cpDecision.label, round, metrics })
    }

    // ── Stage 2: distill web_search results into knowledge base ──
    if (options.knowledgeBase && learnPrompts.length > 0) {
      for (const tc of completedToolCalls) {
        if (tc.name !== "web_search") continue
        const query = (tc.input as Record<string, unknown>).query as string | undefined
        if (!query || !shouldDistill(query, "error")) continue
        const resultEntry = resultsContent.find(r => r.tool_use_id === tc.id)
        if (!resultEntry) continue
        const resultText = String(resultEntry.content ?? "")
        if (!resultText.includes("[SearXNG]") && !resultText.includes("[DuckDuckGo]")) continue
        // Fire distillation (best-effort, don't block next round if it fails)
        distillAndStore(
          { query, results: resultText, trigger: "error" },
          provider,
          options.knowledgeBase,
          options.modelRouter?.selectForPurpose("knowledge_distill") ?? "deepseek-v4-flash",
        ).catch(() => {})
      }
    }

    // ── Memory reconcile: periodic prune + FTS5 rebuild every 50 rounds ──
    if (options.knowledgeBase && round > 0 && round % 50 === 0) {
      const recResult = options.knowledgeBase.reconcile()
      if (recResult.pruned > 0) {
        yield { type: "status", data: `knowledge-reconcile: pruned ${recResult.pruned} expired, ${recResult.indexed} active` }
      }
    }
  }

  options.runTrace?.record("agent_loop_finished", {
    apiCalls: usage.apiCalls,
    changedFiles: [...taskFiles],
    toolErrors: taskToolErrors,
    modifiedFiles: taskModifiedFiles,
  })
  setRuntimeContextBudgetMode("normal")
  sandbox.dispose()
  setShellSandbox(null)

  // ── Gate telemetry: yield summary + auto-save if configured ──
  if (gateTelemetry.gateNames().length > 0) {
    yield { type: "status", data: `gate-telemetry: ${gateTelemetry.gateNames().length} gates\n${gateTelemetry.report()}` }
  }
  await flushTelemetry()

  // PR-7.2: Dispatch Stop hook (fire-and-forget — errors are silently caught)
  if (hooks) {
    await hooks.dispatchStop({
      reason: "completed",
      totalRounds: finalRound,
      sessionDurationMs: Date.now() - startTime,
    })
  }
}

function isNonRetryableProviderStreamError(error: string): boolean {
  return /^(auth|client|quota)(?:\s|:)/i.test(error)
    || /insufficient[_\s-]*quota|quota[_\s-]*(?:exceeded|insufficient)|(?:exceeded|insufficient)[_\s-]*quota|balance|billing|payment\s*required|prepaid|credits?|额度|余额|欠费|账户余额|资源包|套餐/i.test(error)
}
