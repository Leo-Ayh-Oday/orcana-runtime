/** Run context assembly (ALK PR-L7).
 *
 *  Ports the pre-clarification setup of loop.ts (prompt handling, flash
 *  triage, run state creation, sandbox/permission/tooling wiring) into a
 *  single `buildRunContext()` so loop.ts becomes a thin orchestrator.
 *
 *  Returns either a fully assembled RunPhaseContext or an early-stop decision
 *  (prompt blocked by hook). Abort-at-start is handled by the orchestrator
 *  before this is called, matching the historical position of that check.
 */

import type { ProviderMessage } from "../../provider/types"
import type { AgentOptions } from "../loop-types"
import type { AgentRunLifecycleState } from "../run/types"
import { requireRuntimeExecutionContext } from "../../runtime/execution-context"
import { resolveMaxRounds, selectRecentHistoryWithinBudget } from "../round/helpers"
import { buildEffectivePrompt } from "../clarification"
import { detectLanguage, languageInstruction } from "../language"
import { createState } from "../router"
import { CacheTracker } from "../../provider/cache-tracker"
import { ErrorTracker } from "../round/pre-loop"
import { GateTelemetry } from "../gates/telemetry"
import { buildContextKernel } from "../../context/kernel"
import { classifyIntent } from "../intent"
import {
  FlashTriage,
  buildTrackerFromTriage,
  resolveFlashTriagePolicy,
  shouldUseFlashTriage,
  triageModeToIntent,
  activateSkillNamesByKeywords,
} from "../flash-triage"
import { activateSkillsByNames } from "../../skills/registry"
import { createTaskTracker } from "../task-tracker"
import { buildExperienceKernelContext } from "../../experience/kernel"
import { classifyResearchRoute } from "../research-router"
import { createAgentRunState } from "../run/state"
import { createEvidenceLedger } from "../evidence-ledger"
import { ConfidenceEvaluator } from "../../evaluator/confidence"
import { FlashJudge, TestimonyLedger } from "../flash-judge"
import { PermissionGate } from "../permission"
import { loadUserConfig, loadProjectConfig } from "../permission-config"
import { SandboxManager } from "../../sandbox/sandbox"
import { setShellSandbox } from "../../tools/shell"
import { setActiveMode } from "../mode-contract"
import { ToolExecutionLedger } from "../tool-ledger"
import { StateMachine, AgentState } from "../state-machine"
import { createEpochState, epochThresholdsForContext } from "../context-epoch"
import type { LoopDecision, RunPhaseContext } from "./types"

export interface BuildRunContextResult {
  ctx: RunPhaseContext | null
  earlyStop: LoopDecision | null
}

export async function buildRunContext(
  prompt: string,
  options: AgentOptions,
  lifecycle: AgentRunLifecycleState,
): Promise<BuildRunContextResult> {
  const { provider, model, tools, stagedContext, hooks } = options
  const planStore = options.planStore ?? requireRuntimeExecutionContext().planStore
  const artifactStore = options.artifactStore
  const runId = options.runId
  const capabilityRegistry = options.capabilityRegistry
  const maxRounds = resolveMaxRounds(options.maxRounds, process.env.ORCANA_MAX_ROUNDS)

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
      return {
        ctx: null,
        earlyStop: { kind: "return", reason: "prompt_blocked", blockReason: promptResult.blockReason },
      }
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
      const { buildTaskTrackerFromPrompt } = await import("../task-packet")
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
    // R1: the harness may inject its run-scoped evidence ledger so node and
    // kernel write to ONE authoritative instance (same pattern as sandbox).
    evidenceLedger: options.evidenceLedger ?? createEvidenceLedger(),
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
  const cacheStableTools = process.env.ORCANA_CACHE_STABLE_TOOLS !== "0"
  const confidenceEvaluator = new ConfidenceEvaluator()
  const judgeModel = options.modelRouter?.selectForPurpose("completion_judge") ?? "deepseek-v4-flash"
  const flashJudge = new FlashJudge(provider, judgeModel)
  const testimonyLedger = new TestimonyLedger()
  const permissionGate = new PermissionGate()
  // Load user + project permission configs (gracefully)
  const userCfg = loadUserConfig()
  const projectCfg = loadProjectConfig(process.cwd())
  permissionGate.loadRules(userCfg?.rules ?? [], projectCfg?.rules ?? [])
  // Sandbox init — shared Job Object for all shell commands in this agent run.
  // H3: the harness may inject its run-scoped sandbox so a run has a single
  // owner; otherwise created here with the same defaults.
  const sandbox = options.sandbox ?? new SandboxManager({
    projectRoot: process.cwd(),
    maxRuntimeSec: Number(process.env.ORCANA_SANDBOX_TIMEOUT_SEC) || 30,
    jobMemoryLimitMb: process.env.ORCANA_SANDBOX_MEMORY_MB ? Number(process.env.ORCANA_SANDBOX_MEMORY_MB) : 512,
  })
  setShellSandbox(sandbox)
  // PR 8: set active mode contract from options (defaults to "coder")
  setActiveMode(options.activeMode ?? "coder")
  const pmode: "full" | "strict" = process.env.ORCANA_PERMISSION_MODE === "strict" ? "strict" : "full"
  const toolLedger = new ToolExecutionLedger()
  const gateBlockCounts = new Map<string, { count: number; lastSeen: number }>()
  const deferredGateMessages: string[] = []
  options.runTrace?.record("agent_loop_started", { maxRounds, toolCount: tools.length })

  // L1 ownership: Router State remains the legacy behavior driver.
  // StateMachine is a read-only monitoring/transition-validation projection.
  const sm = new StateMachine()
  sm.transition(AgentState.UNDERSTAND, "agent loop started")

  // Cumulative context tracking (DeepSeek V4: 1M context window)
  const CONTEXT_MAX = options.contextMaxTokens ?? 1_048_576

  // ── Context Epoch (PR 4): four-layer context architecture ──
  runState.budget.epoch = createEpochState(epochThresholdsForContext(CONTEXT_MAX))
  const usage = runState.budget.usage
  const epochState = runState.budget.epoch
  const taskFiles = runState.execution.taskFiles

  const ctx: RunPhaseContext = {
    options,
    provider,
    model,
    tools,
    hooks,
    abortSignal: options.abortSignal,
    maxRounds,
    stagedContext,
    thinkingStore: options.thinkingStore,
    knowledgeBase: options.knowledgeBase,
    modelRouter: options.modelRouter,
    runTrace: options.runTrace,
    gateTelemetry,
    gateTelemetryFile: options.gateTelemetryFile,
    prompt,
    effectivePrompt,
    language,
    langInstruction,
    rawMessages,
    state,
    cacheTracker,
    errorTracker,
    contextKernel,
    researchDecision,
    experienceContext,
    triageResult,
    runState,
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
    artifactStore,
    runId,
    capabilityRegistry,
    confidenceEvaluator,
    flashJudge,
    testimonyLedger,
    permissionGate,
    sandbox,
    pmode,
    toolLedger,
    gateBlockCounts,
    deferredGateMessages,
    sm,
    contextMap: {
      runtimeContextMap: null,
      contextMapContext: "",
      contextReadinessBlockers: [],
      contextReadinessBlocked: false,
      planContextAttachment: undefined,
    },
    CONTEXT_MAX,
    cacheStableTools,
    taskFiles,
    usage,
    epochState,
    lifecycle,
  }
  return { ctx, earlyStop: null }
}
