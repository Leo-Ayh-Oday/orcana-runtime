/** Agent while-True tool loop — with self-learn triggers, staged context, thinking store, post-edit lint. */

import type { LLMProvider, ProviderMessage, StreamEvent } from "../provider/types"
import { isRuntimeBuiltToolDescriptor, type ToolDescriptor } from "../tools/registry"
import { isBuiltinVerificationProducer } from "../tools/builtins"
import { createState, decideThinkingPlan, updateState } from "./router"
import { buildSystemPrompt } from "./prompts"
import { CacheTracker } from "../provider/cache-tracker"
import type { StagedContextManager } from "../context/staged"
import type { ThinkingStore } from "../memory/thinking-store"
import type { KnowledgeBase } from "../memory/knowledge"
import { buildContextKernel } from "../context/kernel"
import { classifyIntent } from "./intent"
import { FlashTriage, triageModeToIntent, triageToTaskIntent, buildTrackerFromTriage, activateSkillNamesByKeywords, resolveFlashTriagePolicy, shouldUseFlashTriage } from "./flash-triage"
import { activateSkillsByNames } from "../skills/registry"
import { revisePlan } from "./task-tracker"
import type { TaskPacket } from "./task-packet"
import { createMasterPlan, createMasterPlanFromPacket, nodesFromPlanText, markNodeDone, buildNodeReviewGate, currentNode, planComplete, planProgress, type MasterPlan } from "./master-plan"
import { validatePlan, validateNode, formatValidationReport } from "./plan-validator"
import { setRuntimeContextBudgetMode } from "./runtime-context"
import { requireRuntimeExecutionContext } from "../runtime/execution-context"
import type { RippleReport } from "../ripple/types"
import { getBlockingObligations, normalizeProjectPath } from "../ripple/obligations"
import { resetRippleProgram, setCascadeFiles } from "../ripple/engine"
import type { ModelRouter } from "../provider/router"
import { ConfidenceEvaluator } from "../evaluator/confidence"
import { AgentState, StateMachine } from "./state-machine"
import { formatRoundBudgetExhausted, resolveMaxRounds, selectRecentHistoryWithinBudget } from "./round/helpers"
import { isRecord, collectRecentTurns, mcThreshold, updateStateMachine, type StateMachineInput } from "./round/post-loop"
import { ErrorTracker, buildVolatileContextMessage, collectResearchEvidence, explicitRequiredFiles } from "./round/pre-loop"
import type { HookSystem } from "../hooks"
import { ToolExecutionLedger } from "./tool-ledger"

import { formatServiceTestGuidance, parseVerificationResult, type VerificationResult } from "../verification/result"
import { bindVerificationToLedger, runBatchTypecheckAndTaskTracker, runRippleVerificationPhase, runRuntimeSelfEditGate } from "./verification/coordinator"
import { runAdaptiveCheckpoint, runForwardMicrocompact, runHistoricalMicrocompact, runKnowledgeDistillation, runKnowledgeReconcile, runSemanticRecall, runThinkingCompaction } from "./maintenance/coordinator"
import type { AgentRunTrace } from "./run-trace"
import {
  createTaskTracker,
  formatTaskPlanningPrompt,
  formatTaskTrackerPrompt,
  formatTaskTrackerStatus,
  markPlanAccepted,
  missingTaskRequirements,
  snapshotTaskTracker,
} from "./task-tracker"
import { buildEffectivePrompt, buildModelClarificationCall, evaluateClarificationNeed, formatModelClarificationFailure, parseModelClarification } from "./clarification"
import { buildExperienceKernelContext } from "../experience/kernel"
import { evaluatePlanningArtifact, forcePlanningPassAfterLimit, formatPlanningBlockedToolResult, formatPlanningGatePrompt } from "./planning-gate"
import { detectLanguage, languageInstruction, type UILanguage } from "./language"
import { CompletionOrchestrator } from "./completion-orchestrator"
import { buildResearchEvidenceContext, buildResearchInsufficientEvidenceMessage } from "./research-answer"
import { classifyResearchRoute, shouldRunResearch } from "./research-router"
import { FlashJudge, TestimonyLedger } from "./flash-judge"
import { PermissionGate } from "./permission"
import { loadUserConfig, loadProjectConfig } from "./permission-config"
import { executeToolBatch } from "./tool-execution/batch-executor"
import { GateTelemetry } from "./gates/telemetry"
import { SandboxManager } from "../sandbox/sandbox"
import { setShellSandbox } from "../tools/shell"
import { buildContextMessages, buildRoundProviderRequest, cacheStableProviderTools, estimateRoundTokens } from "./round/request-builder"
import { createPreRoundChain } from "./gates/pre-round"
import { processGateOverflow } from "./gates/overflow"
import { createEpochState, buildPlanStateContext, classifyEpochAction, epochThresholdsForContext, formatEpochBudgetWarning, formatEpochStatus, totalMessageChars, epochRollover, type PlanStateInput } from "./context-epoch"
import { clearActivePatchContext, clearTransactionRegistry, currentTransactionEvidenceBinding, setActivePatchContext } from "./patch-transaction"
import { createEvidenceLedger } from "./evidence-ledger"
import { getWriteGeneration } from "../file-state"
import { setActiveMode, getActiveMode, formatModePrompt, shouldTransitionMode } from "./mode-contract"
import type { ModeTransitionContext } from "./mode-contract"
import { buildContextMap, contextEvidenceForMap, evaluateContextReadiness, formatContextMapSummary, selectContextMapTaskLevel, type ContextMap, type ContextMapTaskLevel } from "../context/context-map"
import { createAgentRunState, createRoundState } from "./run/state"
import type { AgentRunLifecycleState } from "./run/types"
import { createAgentRunScope, runWithAgentRunScope } from "./run/scope"
import { setCurrentPlan } from "./run/plan-store"
import { runProviderRound, streamProviderRoundEvents } from "./provider/round-runner"
import { createProviderRoundResult, type ProviderRoundResult } from "./provider/round-result"
import { decideProviderFailureRecovery } from "./provider/failure-policy"

import type { UsageStats, AgentOptions } from "./loop-types"
export type { UsageStats, AgentOptions }

function trustedVerificationFromTool(
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

export async function* agentLoop(
  prompt: string,
  options: AgentOptions,
): AsyncGenerator<StreamEvent> {
  const scope = createAgentRunScope({
    tools: options.tools,
    planStore: options.planStore,
    id: options.sessionId ? `agent-run:${options.sessionId}` : undefined,
  })
  const runOptions: AgentOptions = {
    ...options,
    tools: scope.toolRegistry.tools,
    planStore: scope.planStore,
  }
  const iterator = runAgentLoop(prompt, runOptions)
  let completed = false

  try {
    while (true) {
      const step = await runWithAgentRunScope(scope, () => iterator.next())
      if (step.done) {
        completed = true
        return
      }
      yield step.value
    }
  } finally {
    if (!completed) {
      await runWithAgentRunScope(scope, () => iterator.return(undefined))
    }
  }
}

async function* runAgentLoop(
  prompt: string,
  options: AgentOptions,
): AsyncGenerator<StreamEvent> {
  const { provider, model, tools, stagedContext, hooks } = options
  const planStore = options.planStore ?? requireRuntimeExecutionContext().planStore
  const maxRounds = resolveMaxRounds(options.maxRounds, process.env.DEEPSEEK_MAX_ROUNDS)
  const lifecycle: AgentRunLifecycleState = {
    startedAt: Date.now(),
    finalRound: 0,
    stopReason: "aborted",
    stopHookDispatched: false,
    reachedRoundBudget: false,
  }
  const dispatchStopHook = async (reason: typeof lifecycle.stopReason, totalRounds = lifecycle.finalRound) => {
    if (!hooks || lifecycle.stopHookDispatched) return
    lifecycle.stopHookDispatched = true
    await hooks.dispatchStop({ reason, totalRounds, sessionDurationMs: Date.now() - lifecycle.startedAt })
  }
  if (options.abortSignal?.aborted) {
    await dispatchStopHook("aborted", 0)
    return
  }
  const effectivePrompt = buildEffectivePrompt(prompt, options.conversationHistory)
  const language = detectLanguage(effectivePrompt)
  const langInstruction = languageInstruction(language)

  const rawMessages: ProviderMessage[] = []

  // Load conversation history up to a token budget (~15% of 1M context).
  // This replaces the hardcoded slice(-24) with budget-aware truncation.
  if (options.conversationHistory?.length) {
    const ESTIMATED_CHARS_PER_TOKEN = 3
    const HISTORY_TOKEN_BUDGET = 150_000
    const recent = selectRecentHistoryWithinBudget(
      options.conversationHistory,
      HISTORY_TOKEN_BUDGET,
      ESTIMATED_CHARS_PER_TOKEN,
      60,
    )
    for (const h of recent) {
      rawMessages.push({ role: h.role, content: h.content })
    }
  }

  rawMessages.push({ role: "user", content: prompt })

  // PR-7.2: Dispatch UserPromptSubmit hook — can inject context, replace prompt, or block
  if (hooks) {
    const promptResult = await hooks.dispatchPromptSubmit({ prompt, round: 0 })
    if (promptResult.blocked) {
      lifecycle.stopReason = "blocked"
      await dispatchStopHook(lifecycle.stopReason, 0)
      yield { type: "error", data: `Prompt blocked by hook: ${promptResult.blockReason}` }
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
  let initialIntentPolicy: ReturnType<typeof classifyIntent>
  let initialTaskTracker: ReturnType<typeof createTaskTracker> = null
  let initialTriageSkillPrompts: string[] = []

  if (triageResult) {
    // Flash succeeded — use semantic classification
    initialIntentPolicy = { mode: triageModeToIntent(triageResult.mode), reason: `Flash triage: ${triageResult.reasoning}` }
    const trackerDef = buildTrackerFromTriage(triageResult, effectivePrompt)
    if (trackerDef) {
      initialTaskTracker = { ...trackerDef, verificationEvidence: {}, verification: trackerDef.requiredVerificationKinds.map(k => k === "typecheck" ? "运行类型检查" : k === "test" ? "运行测试" : k === "build" ? "运行构建" : "运行验证") }
    }
    initialTriageSkillPrompts = activateSkillsByNames(triageResult.relevantSkillNames)
  } else {
    // Flash unavailable — fallback to classifiers
    // PR-2.3: long_task now routes through TaskPacket path; narrow_edit still uses keyword-based
    initialIntentPolicy = classifyIntent(effectivePrompt)
    if (initialIntentPolicy.mode === "long_task") {
      const { buildTaskTrackerFromPrompt } = await import("./task-packet")
      initialTaskTracker = buildTaskTrackerFromPrompt(effectivePrompt, initialIntentPolicy.mode)
    } else {
      initialTaskTracker = createTaskTracker(effectivePrompt, initialIntentPolicy.mode)
    }
    initialTriageSkillPrompts = activateSkillsByNames(activateSkillNamesByKeywords(effectivePrompt))
  }

  const researchDecision = triageResult?.needsWeb && triageResult.researchQueries.length > 0
    ? {
        mode: "research_answer" as const,
        confidence: 0.85,
        needWeb: true,
        reason: `Flash triage: ${triageResult.reasoning}`,
        researchQuestions: triageResult.researchQueries,
      }
    : classifyResearchRoute({ prompt: effectivePrompt, intentMode: initialIntentPolicy.mode })
  const experienceContext = buildExperienceKernelContext({ prompt: effectivePrompt, intentMode: initialIntentPolicy.mode })
  const runState = createAgentRunState({
    sessionId: options.sessionId,
    prompt,
    effectivePrompt,
    language,
    rawMessages,
    intentPolicy: initialIntentPolicy,
    taskTracker: initialTaskTracker,
    planStore,
    evidenceLedger: createEvidenceLedger(),
    skillPrompts: initialTriageSkillPrompts,
    planApproved: options.initialPlanState === "approved",
    lifecycle,
  })
  // L1 compatibility references: these point at canonical state-owned objects
  // and are never reassigned. Mutable scalar facts use their owning section.
  const planning = runState.planning
  const execution = runState.execution
  const verificationState = runState.verification
  const budget = runState.budget
  const notices = runState.notices
  const maintenance = runState.maintenance
  const intentPolicy = runState.planning.intentPolicy
  const evidenceLedger = runState.verification.evidenceLedger
  const triageSkillPrompts = runState.research.skillPrompts
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
  try {
  // PR 8: set active mode contract from options (defaults to "coder")
  setActiveMode(options.activeMode ?? "coder")
  const pmode: "full" | "strict" = process.env.DEEPSEEK_PERMISSION_MODE === "strict" ? "strict" : "full"
  const toolLedger = new ToolExecutionLedger()
  const gateBlockCounts = new Map<string, { count: number; lastSeen: number }>()
  const deferredGateMessages: string[] = []
  options.runTrace?.record("agent_loop_started", { maxRounds, toolCount: tools.length })

  // L1 ownership: Router State remains the legacy behavior driver.
  // StateMachine is a read-only monitoring/transition-validation projection.
  const sm = new StateMachine()
  sm.transition(AgentState.UNDERSTAND, "agent loop started")

  const clarification = evaluateClarificationNeed({
    prompt: effectivePrompt,
    tracker: runState.planning.taskTracker,
    history: options.conversationHistory,
  })
  if (clarification.required) {
    yield { type: "status", data: "clarification-gate: thinking before planning" }
    let modelText = ""
    let modelFailed = !runState.planning.taskTracker
    let modelInputTokens = 0
    if (runState.planning.taskTracker) {
      const clarificationCall = buildModelClarificationCall({
        provider,
        model,
        prompt: effectivePrompt,
        tracker: runState.planning.taskTracker,
        result: clarification,
        language,
      })
      modelInputTokens = Math.max(1, Math.round((clarificationCall.system.length + JSON.stringify(clarificationCall.messages).length) / 3))
      try {
        for await (const event of streamProviderRoundEvents({
          provider,
          request: clarificationCall,
          abortSignal: options.abortSignal,
        })) {
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
    await dispatchStopHook("aborted", 0)
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
    runState.research.evidence = await collectResearchEvidence({
      tools,
      queries: researchDecision.researchQuestions,
      hooks,
    })
    const successCount = runState.research.evidence.filter(item => item.success).length
    yield { type: "status", data: `research-router: evidence ${successCount}/${runState.research.evidence.length}` }
    runState.research.context = successCount > 0
      ? buildResearchEvidenceContext(researchDecision, runState.research.evidence)
      : { role: "user", content: buildResearchInsufficientEvidenceMessage(researchDecision, runState.research.evidence) }
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

  // Cumulative context tracking (DeepSeek V4: 1M context window)
  const CONTEXT_MAX = options.contextMaxTokens ?? 1_048_576

  // ── Context Epoch (PR 4): four-layer context architecture ──
  runState.budget.epoch = createEpochState(epochThresholdsForContext(CONTEXT_MAX))
  const usage = runState.budget.usage
  const epochState = runState.budget.epoch
  const taskFiles = runState.execution.taskFiles

  const syncModeWithMasterPlan = (): void => {
    if (!planStore.current) return
    const activeNode = currentNode(planStore.current)
    const transitionCtx: ModeTransitionContext = {
      activeNodeStatus: activeNode?.status,
      hasTrackerSteps: (activeNode?.tracker?.steps?.length ?? 0) > 0,
      rippleObligationCount: verificationState.rippleObligations.length,
      hasEvidence: evidenceLedger.entries.length > 0,
      toolErrors: errorTracker.errorCount,
      planComplete: planComplete(planStore.current),
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
      setCurrentPlan(planStore, plan)
      const cur = currentNode(plan)
      if (!cur) return false
      planning.taskTracker = cur.tracker
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
    setCurrentPlan(planStore, plan)
    // PR 3: re-validate after dependency transfer — mutations may introduce cycles
    plan._lastValidation = validatePlan(plan)
    const cur = currentNode(plan)
    if (!cur) return false
    planning.taskTracker = cur.tracker
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
    if (!planStore.current || !planning.taskTracker) return false
    const cur = currentNode(planStore.current)
    if (cur) markNodeDone(planStore.current, cur.id, "验证通过")
    const review = buildNodeReviewGate(planStore.current, cur?.id ?? "")
    // PR 3: validate plan before injecting review prompt
    planStore.current._lastValidation = validatePlan(planStore.current)
    // Inject as user message — this is an instruction to review the plan, not model output
    const validationText = formatValidationReport(planStore.current._lastValidation)
    const fullPrompt = validationText
      ? `${review.promptText.slice(0, 1600)}\n\n${validationText}`
      : review.promptText.slice(0, 2000)
    rawMessages.push({ role: "user" as const, content: fullPrompt })
    syncModeWithMasterPlan()
    if (planComplete(planStore.current)) return false
    // Blocked nodes still need model review — continue even when !review.resume
    if (review.remaining === 0) return false
    // If next node was auto-activated, swap to its tracker
    const next = currentNode(planStore.current)
    if (next && review.resume) {
      planning.taskTracker = next.tracker
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

  if (planning.planApproved && options.planText && planning.taskTracker) {
    markPlanAccepted(planning.taskTracker)
    if (activateMasterPlan(options.planText, planning.taskTracker.goal)) {
      yield { type: "status", data: `master-plan: ${planProgress(planStore.current!)} nodes` }
    }
    yield { type: "status", data: "任务追踪: 用户已确认规划，进入执行阶段" }
    planning.planApproved = false
  }

  for (let round = 0; round < maxRounds; round++) {
    lifecycle.finalRound = round
    options.runTrace?.record("round_started", { round })
    // All provider/tool temporaries for this iteration are owned here and become
    // unreachable on continue/break. Only explicit commits reach AgentRunState.
    const roundState = createRoundState(round)
    const thinkingDecision = decideThinkingPlan(state, execution.requestedMaxThinking ? "max" : options.thinkEffort, {
      prompt: effectivePrompt,
      intentMode: intentPolicy.mode,
      planningPhase: planning.taskTracker?.phase === "planning",
      autoMaxSignals: { consecutiveErrors: execution.consecutiveErrors, modifiedFiles: execution.modifiedFileCount },
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
    if (!runState.conversation.frozenStablePrefix) {
      const stablePrefixParts: string[] = []
      if (options.stableMemoryContext?.trim()) stablePrefixParts.push(`## Stable Cold Memory\n${options.stableMemoryContext.trim()}`)
      if (experienceContext) stablePrefixParts.push(experienceContext)
      if (contextKernel.text) stablePrefixParts.push(`## Project Context Kernel\n${contextKernel.text}`)
      if (contextMapContext) stablePrefixParts.push(contextMapContext)
      if (triageSkillPrompts.length) stablePrefixParts.push(triageSkillPrompts.join("\n\n"))
      runState.conversation.frozenStablePrefix = stablePrefixParts.length > 0
        ? { role: "user", content: ["## Stable Prefix Context\n[CACHE_ANCHOR:v3]", stablePrefixParts.join("\n\n")].join("\n\n") }
        : null
    }
    const stablePrefixContext = runState.conversation.frozenStablePrefix
    // ── Plan State Context (PR 4, Layer 2): survives epoch rollover ──
    const planStateInput: PlanStateInput = {
      masterPlan: planStore.current,
      taskTracker: planning.taskTracker,
      taskPacket: planStore.current
        ? (currentNode(planStore.current)?._packet ?? null)
        : null,
      rippleObligations: verificationState.rippleObligations,
      userGoal: planStore.current?.goal ?? planning.taskTracker?.goal ?? effectivePrompt.slice(0, 200),
      decisions: [], // TODO PR 6/7: wire Evidence/Ripple decisions into plan state
      round,
    }
    const planStateText = buildPlanStateContext(planStateInput)
    const planStateContext: ProviderMessage | null = planStateText.length > 0
      ? { role: "user", content: planStateText }
      : null
    const volatileContext = buildVolatileContextMessage(ctxText, thinkContext, knowledgeContext)
    const taskPlanning = planning.taskTracker?.phase === "planning"
    const planningContext: ProviderMessage | null = taskPlanning && planning.taskTracker
      ? { role: "user", content: formatTaskPlanningPrompt(planning.taskTracker, round) }
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
      researchContext: runState.research.context,
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
    if (!notices.announcedKernel) {
      notices.announcedKernel = true
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
      rippleReports: verificationState.lastRippleReports,
      pendingRippleObligations: verificationState.rippleObligations,
      intentReadonly: intentPolicy.mode === "readonly",
      taskPlanning: Boolean(taskPlanning),
      contextReadinessBlocked,
      cacheStableTools,
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
    const { roundInputTokens, providerMessages } = estimateRoundTokens(
      system, contextMessages, rawMessages, budgetContext,
    )
    const estimatedRoundInputTokens = roundInputTokens
    usage.estimatedInputTokens += roundInputTokens
    budget.contextInput += roundInputTokens

    if (!preRoundResult.pass) {
      // Context budget block — hard exit
      yield { type: "status", data: `context-budget: block ${preRoundCtx.contextBudgetPercent}%` }
      options.runTrace?.record("gate_decision", { gate: "policy:context_budget", decision: "block", percent: preRoundCtx.contextBudgetPercent })
      yield { type: "text", data: preRoundResult.message ?? "Context budget exceeded." }
      break
    }
    if ((preRoundCtx.contextBudgetMode as string) === "degraded" && !notices.announcedContextDegraded) {
      notices.announcedContextDegraded = true
      yield { type: "status", data: `context-budget: degraded ${preRoundCtx.contextBudgetPercent}%; finish current stage only` }
    }

    // ── PR 4: Epoch budget warning on force-compress (one-shot) ──
    if (epochAction === "forceCompress" && !notices.announcedEpochForceCompress) {
      notices.announcedEpochForceCompress = true
      const epochWarning = formatEpochBudgetWarning(
        Math.round((epochTotalChars / epochState.thresholds.forceCompressChars) * 100),
        epochState.thresholds,
      )
      // Inject as a user message into rawMessages to warn the model
      rawMessages.push({ role: "user", content: epochWarning })
      yield { type: "status", data: `epoch-budget: force-compress — ${Math.round(epochTotalChars / 1000)}k chars` }
    }

    // Apply ripple block side effects
    execution.rippleBlockActive = preRoundCtx.rippleBlockActive
    if (execution.rippleBlockActive) {
      for (const report of verificationState.lastRippleReports) sandbox.blockFileWrite(report.targetFile)
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
    if (round === 0 && planning.taskTracker) {
      yield { type: "status", data: "任务追踪: 已识别为长任务，先规划再执行" }
    }
    if (planning.taskTracker) {
      const status = formatTaskTrackerStatus(planning.taskTracker)
      if (status) yield { type: "status", data: status }
      yield { type: "task_progress", data: snapshotTaskTracker(planning.taskTracker) }
    }
    if (preRoundCtx.taskPlanning && round > 0) {
      yield { type: "status", data: "任务追踪: 规划阶段只输出计划" }
    }
    if (execution.rippleBlockActive) {
      yield { type: "status", data: `涟漪阻止: 写工具已禁用 (${verificationState.rippleObligations.length} 个调用方未更新)` }
      options.runTrace?.record("gate_decision", { gate: "ripple_block", decision: "block", pending: verificationState.rippleObligations.length })
    }
    const roundRequest = buildRoundProviderRequest({
      modelName,
      system,
      providerMessages,
      tools: activeTools,
      cacheTracker,
      thinkingTokenTotal: budget.thinkingTokens,
      contextInputTotal: budget.contextInput,
      contextOutputTotal: budget.contextOutput,
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
      abortSignal: options.abortSignal,
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
          options.runTrace?.record("provider_status", { round, status: event.data })
        }
        yield event
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

    if (options.abortSignal?.aborted) {
      options.runTrace?.record("agent_loop_aborted", { round, reason: String(options.abortSignal.reason ?? "aborted") })
      return
    }

    const roundMs = Date.now() - roundState.startedAt

    const textChunks = roundState.textChunks
    const completedToolCalls = roundState.toolCalls
    const finalText = roundState.finalText
    options.runTrace?.record("round_output", {
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
      budget.contextInput += providerRoundInputTokens - estimatedRoundInputTokens
    }

    const estimatedOutputTokens = Math.round(finalText.length / 3 + completedToolCalls.reduce((s, tc) => s + JSON.stringify(tc.input).length / 3, 0))
    budget.contextOutput += roundState.providerUsage?.outputTokens ?? estimatedOutputTokens
    const displayedCacheHitRate = roundState.providerUsage?.cacheHitRate ?? cacheTracker.hitRate
    const finalUsageEvent = {
        requestedModel: modelName,
        actualModel: roundState.providerUsage?.actualModel,
        inputTokens: budget.contextInput,
        outputTokens: budget.contextOutput,
        contextMax: CONTEXT_MAX,
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
    options.runTrace?.record("token_usage", finalUsageEvent)
    yield {
      type: "token_usage",
      data: finalUsageEvent,
    }

    if (roundState.providerFailure) {
      const recovery = decideProviderFailureRecovery({
        failure: roundState.providerFailure,
        round,
        maxRounds,
        finalText,
        taskTracker: planning.taskTracker,
        changedFiles: [...taskFiles],
      })
      for (const message of recovery.messages) rawMessages.push(message)
      if (recovery.emitError) {
        yield { type: "error", data: roundState.providerFailure.message }
      }
      yield { type: "status", data: recovery.status }
      if (recovery.text) yield { type: "text", data: recovery.text }
      options.runTrace?.record("gate_decision", recovery.trace)
      if (recovery.action === "continue") continue
      break
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
        lastTypecheck: verificationState.lastTypecheck,
        lastRippleReports: verificationState.lastRippleReports,
        planApproved: planning.planApproved,
        planningRejections: planning.planningRejections,
        maxRounds,
        priorTools: execution.lastToolNames,
        priorFiles: taskFiles,
        confidenceEvaluator,
        evidenceLedger,
        evidenceBinding: currentTransactionEvidenceBinding(),
        testimonyLedger,
        flashJudge,
        masterPlan: planStore.current,
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
        // The model's finalText is either already streamed or emitted below for
        // buffered runs. Emitting the accepted evidence wrapper as assistant
        // text duplicates that response; the TUI then mistakes its four-line
        // compact preview for the full answer and hides the real trailing text.
        if (isCompletionEvidenceReport(t)) continue
        yield { type: "text", data: t }
      }
      for (const ev of orchResult.traceEvents) {
        options.runTrace?.record("gate_decision", ev)
      }
      if (orchResult.planningRejections !== undefined) {
        planning.planningRejections = orchResult.planningRejections
      }

      // Handle plan auto-approve → activate master plan
      if (orchResult.activateMasterPlan) {
        const { planText, goal, forcePacket } = orchResult.activateMasterPlan
        if (activateMasterPlan(planText, goal, forcePacket)) {
          yield { type: "status", data: `master-plan: ${planProgress(planStore.current!)} nodes` }
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
          if (orchResult.tryNodeTransition && planStore.current && tryNodeTransition()) {
            yield { type: "status", data: `master-plan: ${planProgress(planStore.current)} → next node activated` }
            options.runTrace?.record("gate_decision", { gate: "master_plan", decision: "next_node", progress: planProgress(planStore.current) })
            continue
          }
          if (planStore.current) {
            yield { type: "status", data: "master-plan: all nodes complete" }
            options.runTrace?.record("gate_decision", { gate: "master_plan", decision: "plan_complete" })
          }
          if (bufferReadonlyText && !roundState.bufferedTextEmitted) {
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
    for (const tb of roundState.thinkingBlocks) assistantContent.push({ type: "thinking", thinking: tb.thinking, signature: tb.signature })
    if (finalText) assistantContent.push({ type: "text", text: finalText })
    for (const tc of completedToolCalls) assistantContent.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input })
    rawMessages.push({ role: "assistant", content: assistantContent })

    // ── Persist thinking chain ──
    if (options.thinkingStore && roundState.thinkingBlocks.length > 0) {
      budget.thinkingTokens += roundState.thinkingBlocks.reduce((sum, tb) => sum + Math.round(tb.thinking.length / 3), 0)
      options.thinkingStore.storeThinking({
        query: effectivePrompt,
        thinkingBlocks: roundState.thinkingBlocks,
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

    // ── Execute tools + self-learn tracking (L4: ToolBatchExecutor) ──
    const toolNames = roundState.toolNames
    const filePaths = roundState.filePaths
    const resultsContent = roundState.toolResults
    const learnPrompts = roundState.learnPrompts
    const modifiedFilesThisRound = roundState.modifiedFiles
    const rippleReportsThisRound = roundState.rippleReports
    const verificationResultsThisRound = roundState.verificationResults

    const { aborted: toolBatchAborted } = yield* executeToolBatch({
      round,
      completedToolCalls,
      tools,
      hooks,
      abortSignal: options.abortSignal,
      runTrace: options.runTrace,
      thinkingStore: options.thinkingStore,
      roundState,
      planning,
      execution,
      verificationState,
      notices,
      intentPolicy,
      permissionGate,
      permissionMode: pmode,
      preRoundCtx,
      contextReadinessBlocked,
      contextReadinessBlockers,
      finalText,
      toolLedger,
      gateTelemetry,
      errorTracker,
      stagedContext,
      prompt,
      resultsContent,
      trustedVerification: trustedVerificationFromTool,
    })
    if (toolBatchAborted) return

    // L5: VerificationCoordinator context — shared across the verification phase.
    const verificationCtx = {
      round,
      intentPolicy,
      effectivePrompt,
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
      runTrace: options.runTrace,
      planStore,
      maxRounds,
    }
    // Bind structured verification to the canonical ledger as soon as tool execution ends.
    bindVerificationToLedger(verificationCtx)

    // L6: MaintenanceCoordinator context — shared across low-frequency housekeeping.
    const maintenanceCtx = {
      round,
      epochAction,
      provider,
      modelRouter: options.modelRouter,
      knowledgeBase: options.knowledgeBase,
      abortSignal: options.abortSignal,
      thinkingStore: options.thinkingStore,
      stableMemoryContext: options.stableMemoryContext,
      effectivePrompt,
      routerRoundNum: state.roundNum,
      execution,
      verificationState,
      runState,
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
      runTrace: options.runTrace,
    }

    // L6: forward microcompact (before history push)
    yield* runForwardMicrocompact(maintenanceCtx)

    let postToolRequiredFilesPrompt = ""
    let postToolPlanningPrompt = ""
    const ripplePhase = yield* runRippleVerificationPhase(verificationCtx)
    postToolRequiredFilesPrompt = ripplePhase.postToolRequiredFilesPrompt

    // ── Gate overflow: track cumulative blocks, force strategy switch at 3, BLOCKED at 5 ──
    sandbox.clearBlockedFiles()

    const overflowResult = processGateOverflow({
      round,
      rippleBlockActive: execution.rippleBlockActive,
      pendingRippleObligationsLength: getBlockingObligations(verificationState.rippleObligations).length,
      postToolPlanningPrompt,
      postToolRequiredFilesPrompt,
      gateBlockCounts,
    })
    for (const msg of overflowResult.deferredMessages) deferredGateMessages.push(msg)
    for (const ev of overflowResult.statusEvents) yield { type: "status", data: ev }

    if (overflowResult.blocked) {
      const reason = `${overflowResult.blockedGate} 累积阻断 ${overflowResult.blockedCount} 次，请求人工介入。`
      sm.transition(AgentState.BLOCKED, reason)
      lifecycle.stopReason = "blocked"
      yield { type: "status", data: `gate-overflow: ${overflowResult.blockedGate} blocked ${overflowResult.blockedCount} times — BLOCKED` }
      options.runTrace?.record("agent_loop_blocked", { reason, gate: overflowResult.blockedGate, blockCount: overflowResult.blockedCount })
      await flushTelemetry()
      return
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
      deferredGateMessages.push(reviseMsg)
      yield { type: "status", data: `revise-plan: ${reason}` }
      options.runTrace?.record("gate_decision", { gate: "revise_plan", decision: "replan", reason })
      } // if (!masterPlan)
    }

    if (planning.taskTracker?.phase === "planning" && finalText.trim()) {
      // User already confirmed → skip gate, accept directly
      if (planning.planApproved) {
        markPlanAccepted(planning.taskTracker)
        if ((options.planText ?? planning.lastPlanText) && activateMasterPlan(options.planText ?? planning.lastPlanText, planning.taskTracker.goal)) {
          yield { type: "status", data: `master-plan: ${planProgress(planStore.current!)} nodes` }
        }
        yield { type: "status", data: "任务追踪: 用户已确认规划，进入执行阶段" }
        planning.planApproved = false
      } else {
        const planningGate = evaluatePlanningArtifact(finalText, planning.taskTracker)
        if (planningGate.ok) {
          markPlanAccepted(planning.taskTracker)
          if (activateMasterPlan(finalText, planning.taskTracker.goal)) {
            yield { type: "status", data: `master-plan: ${planProgress(planStore.current!)} nodes` }
          }
          yield { type: "status", data: "任务追踪: 已读取计划，进入执行阶段" }
          options.runTrace?.record("gate_decision", {
            gate: "planning",
            decision: "accepted",
            score: planningGate.score,
            signals: planningGate.signals,
          })
        } else if (round + 1 < maxRounds) {
          postToolPlanningPrompt = formatPlanningGatePrompt(planningGate, planning.taskTracker)
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

    // L5: batch typecheck + TaskTracker verification projection + lastResults
    yield* runBatchTypecheckAndTaskTracker(verificationCtx)

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

    // L6: retrospective historical microcompact
    yield* runHistoricalMicrocompact(maintenanceCtx)

    // ── State machine transition (after tool results, before next round) ──
    updateStateMachine(sm, {
      roundHadToolError: roundState.hadToolError,
      hadSearchTool: toolNames.some(t => /read_file|web_search|find_symbol|find_references|project_structure|glob|grep/.test(t)),
      hadWriteTool: toolNames.some(t => /write_file|edit_file|edit_fim/.test(t)),
      hadVerifyTool: toolNames.some(t => t === "shell" || t === "typescript"),
      isDone: round + 1 >= maxRounds || false,
      pendingRippleCount: verificationState.rippleObligations.length,
    })
    // Reset one-shot thinking upgrade
    if (execution.requestedMaxThinking) execution.requestedMaxThinking = false

    // L6: one-shot thinking compaction
    yield* runThinkingCompaction(maintenanceCtx)

    // L6: semantic recall (L3 volatile historical context)
    yield* runSemanticRecall(maintenanceCtx)
    updateState(state, toolNames, filePaths, Boolean(roundState.providerFailure) || roundState.hadToolError)
    execution.lastToolNames = [...toolNames]
    if (postToolPlanningPrompt) {
      rawMessages.push({ role: "user", content: postToolPlanningPrompt })
      continue
    }

    // L5: runtime self-edit gate — moved into the VerificationCoordinator.
    const selfEditResult = yield* runRuntimeSelfEditGate(verificationCtx)
    if (selfEditResult.action === "break") break
    if (selfEditResult.action === "continue") continue

    if (roundState.serviceTestGuidanceNeeded) {
      rawMessages.push({ role: "user", content: formatServiceTestGuidance() })
      yield { type: "status", data: "服务型测试: 要求改为测试内启动并关闭服务" }
      options.runTrace?.record("gate_decision", { gate: "service_test", decision: "repair_guidance" })
    }

    if (roundState.narrowEditEvidenceBlocked) {
      continue
    }

    const missingLongTask = missingTaskRequirements(planning.taskTracker)
    if (planning.taskTracker?.phase === "planning" && missingLongTask.length > 0 && round + 1 < maxRounds) {
      rawMessages.push({ role: "user", content: formatTaskPlanningPrompt(planning.taskTracker, round + 1) })
      yield { type: "status", data: "任务追踪: 等待计划文本，下一轮不允许调用工具" }
      options.runTrace?.record("gate_decision", { gate: "semantic:task_tracker", decision: "plan_required", missing: missingLongTask })
      continue
    }
    if (planning.taskTracker && missingLongTask.length > 0) {
      rawMessages.push({ role: "user", content: [
        "## 任务追踪未完成",
        "继续执行。尚未完成：",
        ...missingLongTask.slice(0, 12).map(item => `- ${item}`),
        "",
        "下一轮必须处理第一个未完成项，并在完成后运行验证。",
      ].join("\n") })
      yield { type: "status", data: `任务追踪: 阻止结束，剩余 ${missingLongTask.length} 项` }
      options.runTrace?.record("gate_decision", { gate: "semantic:task_tracker", decision: "continue", missing: missingLongTask })
    } else if (roundState.completionGateText) {
      yield { type: "status", data: "completion-gate: verified write; stopping without extra provider round" }
      yield { type: "text", data: roundState.completionGateText }
      options.runTrace?.record("gate_decision", { gate: "completion", decision: "verified_write_stop" })
      break
    }

    if (stagedContext && completedToolCalls.length && finalText) {
      stagedContext.addSummary(finalText.slice(0, 120))
      stagedContext.advance()
    }

    // L6: adaptive density checkpoint
    yield* runAdaptiveCheckpoint(maintenanceCtx)

    // L6: best-effort web_search -> knowledge base distillation
    runKnowledgeDistillation(maintenanceCtx)

    // L6: periodic memory reconcile (prune + FTS5 rebuild)
    yield* runKnowledgeReconcile(maintenanceCtx)

    if (round + 1 >= maxRounds) lifecycle.reachedRoundBudget = true
  }

  if (lifecycle.reachedRoundBudget) {
    const message = formatRoundBudgetExhausted(maxRounds)
    yield { type: "status", data: `round-budget: exhausted ${maxRounds}` }
    yield { type: "text", data: message }
    options.runTrace?.record("gate_decision", { gate: "round_budget", decision: "paused", maxRounds })
  }

  options.runTrace?.record("agent_loop_finished", {
    apiCalls: usage.apiCalls,
    changedFiles: [...taskFiles],
    toolErrors: execution.toolErrors,
    modifiedFiles: execution.modifiedFileCount,
  })
  // ── Gate telemetry: yield summary + auto-save if configured ──
  if (gateTelemetry.gateNames().length > 0) {
    yield { type: "status", data: `gate-telemetry: ${gateTelemetry.gateNames().length} gates\n${gateTelemetry.report()}` }
  }
  await flushTelemetry()

  lifecycle.stopReason = "completed"
  } catch (error) {
    lifecycle.stopReason = "error"
    throw error
  } finally {
    try {
      setRuntimeContextBudgetMode("normal")
      setCascadeFiles(new Set())
      resetRippleProgram()
      clearActivePatchContext()
      clearTransactionRegistry()
      setShellSandbox(null)
      sandbox.dispose()
    } finally {
      await dispatchStopHook(lifecycle.stopReason)
    }
  }
}

function isCompletionEvidenceReport(text: string): boolean {
  return /^##\s+(Delivery Report|交付报告)\s*$/im.test(text)
    && /^##\s+(Evidence|证据)\s*$/im.test(text)
    && /^##\s+(Risk|风险)\s*$/im.test(text)
}
