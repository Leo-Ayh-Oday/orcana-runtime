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
import { distillUserConstraints, formatConstraintContext } from "../memory/user-constraints"
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
import { createTaskTracker, type TaskStepStatus, type TaskTracker } from "../task-tracker"
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
import { ProgressGovernor, resolveProgressConfig } from "./progress-governor"
import { LoopSupervisor } from "./loop-supervisor"
import { getRunRetryCoordinator } from "../../runtime/execution-context"
import { withRetryCoordinator } from "../../provider/retry"
import { StateMachine, AgentState } from "../state-machine"
import { createEpochState, epochThresholdsForContext } from "../context-epoch"
import type { LoopDecision, RunPhaseContext } from "./types"
import { buildRecoveryPrompt, type SessionCheckpoint } from "../../session/checkpoint"
import { createMasterPlan, currentNode, type MasterPlan, type PlanNodeStatus } from "../master-plan"
import { setCurrentPlan } from "../run/plan-store"

export interface BuildRunContextResult {
  ctx: RunPhaseContext | null
  earlyStop: LoopDecision | null
}

// ── D4 (CHECKPOINT_RESUME_USED): checkpoint → 计划/跟踪器水合 ──

function isNodeStatus(s: string): s is PlanNodeStatus {
  return s === "pending" || s === "active" || s === "blocked" || s === "done" || s === "skipped"
}

function isStepStatus(s: string): s is TaskStepStatus {
  return s === "pending" || s === "running" || s === "done" || s === "failed" || s === "cancelled" || s === "superseded"
}

/**
 * 从 checkpoint 快照重建 MasterPlan（nodes 形状）或 TaskTracker（steps 形状），
 * 让恢复的会话从第一个未完成节点继续。快照无可用计划数据时返回 null。
 */
function hydratePlanFromCheckpoint(
  cp: SessionCheckpoint,
): { plan: MasterPlan | null; tracker: TaskTracker | null } | null {
  const planData = cp.masterPlan
  const goal = typeof planData.goal === "string" && planData.goal.length > 0 ? planData.goal : cp.summary
  if (!goal) return null

  const nodes = Array.isArray(planData.nodes) ? (planData.nodes as Array<Record<string, unknown>>) : []
  if (nodes.length > 0) {
    const plan = createMasterPlan(goal, "long_task", nodes.map(n => String(n.title ?? "?")))
    for (let i = 0; i < plan.nodes.length && i < nodes.length; i++) {
      const source = nodes[i]!
      const node = plan.nodes[i]!
      const status = String(source.status ?? "pending")
      if (isNodeStatus(status)) node.status = status
      if (typeof source.evidence === "string") node.evidence = source.evidence
    }
    const current = typeof planData.current === "string" && plan.nodes.some(n => n.id === planData.current)
      ? planData.current
      : (plan.nodes.find(n => n.status !== "done")?.id ?? plan.nodes[0]!.id)
    plan.current = current
    const cur = currentNode(plan)
    if (cur?.tracker && cp.taskSteps.length > 0) {
      // checkpoint 的 taskSteps 即检查点时刻活动节点的 steps（与 plan.current 同快照）——
      // 恢复其进度，使会话从第一个未完成步骤继续而非重置。
      cur.tracker.steps = cp.taskSteps.map(s => {
        const raw = s.status
        return {
          id: s.id,
          title: s.title,
          status: isStepStatus(raw) ? raw : "pending",
        }
      })
    }
    return { plan, tracker: cur?.tracker ?? null }
  }

  const steps = Array.isArray(planData.steps) ? (planData.steps as Array<Record<string, unknown>>) : []
  // legacy 扁平形状：masterPlan.steps 优先，缺省回退 checkpoint.taskSteps
  const stepSource: Array<Record<string, unknown>> = steps.length > 0
    ? steps
    : cp.taskSteps.map(s => ({ id: s.id, title: s.title, status: s.status }))
  if (stepSource.length > 0) {
    const tracker: TaskTracker = {
      goal,
      intent: "long_task",
      // building：跳过 planning 相位直接继续执行（planning 仅在校验/修订时进入）
      phase: "building",
      requiredFiles: [],
      requiredVerificationKinds: [],
      verificationEvidence: {},
      verification: [],
      steps: stepSource.map(s => {
        const raw = String(s.status ?? "pending")
        return {
          id: String(s.id ?? "?"),
          title: String(s.title ?? "?"),
          status: isStepStatus(raw) ? raw : "pending",
          ...(typeof s.evidence === "string" ? { evidence: s.evidence } : {}),
        }
      }),
    }
    return { plan: null, tracker }
  }
  return null
}

export async function buildRunContext(
  prompt: string,
  options: AgentOptions,
  lifecycle: AgentRunLifecycleState,
): Promise<BuildRunContextResult> {
  const { provider, model, tools, stagedContext, hooks } = options
  // IC04 §31: 所有 run-scoped provider 调用（主 round / flash / judge /
  // compaction 等）自动携带同一 RetryCoordinator（run-scoped provider wrapper）。
  const coordinatedProvider = withRetryCoordinator(provider, getRunRetryCoordinator())
  const planStore = options.planStore ?? requireRuntimeExecutionContext().planStore
  const artifactStore = options.artifactStore
  const runId = options.runId
  const capabilityRegistry = options.capabilityRegistry
  const maxRounds = resolveMaxRounds(options.maxRounds, process.env.ORCANA_MAX_ROUNDS)
  // RT-3: explicit run project root — never a hidden process.cwd() dependency.
  const projectRoot = options.projectRoot ?? process.cwd()

  const effectivePrompt = buildEffectivePrompt(prompt, options.conversationHistory)
  const language = detectLanguage(effectivePrompt)
  const langInstruction = languageInstruction(language)

  const rawMessages: ProviderMessage[] = []
  // X1 触发点② (RC-02.5)：入口窗口截断时蒸馏被裁 user 消息的用户约束。
  let evictedConstraintContext = ""

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
    if (recent.length < options.conversationHistory.length) {
      // 有消息被窗口裁掉：蒸馏被裁 user 消息中的硬约束（非阻塞，失败静默降级）。
      const evicted = options.conversationHistory.slice(0, options.conversationHistory.length - recent.length)
      const evictedUserTexts = evicted.filter(m => m.role === "user").map(m => m.content).filter(Boolean)
      if (evictedUserTexts.length >= 3) {
        try {
          const distilled = await distillUserConstraints(
            // P0-2: run-scoped Provider subcall 必须经 coordinatedProvider ——
            // distillation 的 physical request 计入同一 RetryCoordinator。
            coordinatedProvider,
            options.modelRouter?.selectForPurpose("thinking_compaction") ?? "deepseek-v4-flash",
            evictedUserTexts,
            options.abortSignal,
          )
          if (distilled.success && distilled.constraints.length > 0) {
            evictedConstraintContext = formatConstraintContext(distilled.constraints)
          }
        } catch {
          // 蒸馏失败不阻断主流程（约束丢失但执行继续）
        }
      }
    }
    for (const h of recent) {
      rawMessages.push({ role: h.role, content: h.content })
    }
  }

  if (evictedConstraintContext) {
    rawMessages.push({
      role: "system",
      content: `<system-reminder>\n以下约束来自已被上下文窗口淘汰的历史轮次（蒸馏保留）：\n${evictedConstraintContext}\n</system-reminder>`,
    })
  }

  // D4 (CHECKPOINT_RESUME_USED): 检查点恢复——恢复提示作为 system 消息注入
  // （任务状态叙述，非用户内容）；计划/跟踪器水合见 hydratePlanFromCheckpoint。
  if (options.resumeFromCheckpoint) {
    rawMessages.push({
      role: "system",
      content: buildRecoveryPrompt(options.resumeFromCheckpoint).recoveryPrompt,
    })
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

  const contextKernel = buildContextKernel(projectRoot)

  // ── Flash Triage: semantic task classification (replaces 4 keyword classifiers) ──
  const flashTriagePolicy = options.flashTriagePolicy ?? resolveFlashTriagePolicy()
  const flashTriageEnabled = shouldUseFlashTriage(flashTriagePolicy, effectivePrompt, contextKernel.text)
  const triageModel = options.modelRouter?.selectForPurpose("flash_triage") ?? "deepseek-v4-flash"
  const flashTriage = flashTriageEnabled ? new FlashTriage(coordinatedProvider, triageModel) : null
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
  // D4 (CHECKPOINT_RESUME_USED): 消费 resumeFromCheckpoint——恢复 checkpoint 中的
  // masterPlan（含节点状态）与任务跟踪器，使会话从第一个未完成节点继续而非重新规划。
  if (options.resumeFromCheckpoint) {
    const hydrated = hydratePlanFromCheckpoint(options.resumeFromCheckpoint)
    if (hydrated) {
      if (hydrated.plan) {
        setCurrentPlan(planStore, hydrated.plan)
        planning.taskTracker = hydrated.tracker ?? planning.taskTracker
      } else if (hydrated.tracker) {
        planning.taskTracker = hydrated.tracker
      }
    }
  }
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
  const flashJudge = new FlashJudge(coordinatedProvider, judgeModel)
  const testimonyLedger = new TestimonyLedger()
  const permissionGate = new PermissionGate()
  // Load user + project permission configs.
  // RC-02 B2: 损坏配置 → invalid → 进入 permission-safe-mode（deny 规则不可用即拒绝默认），
  // 绝不静默退回 allow。
  const userCfg = loadUserConfig()
  const projectCfg = loadProjectConfig(projectRoot)
  const userRules = userCfg.status === "valid" ? userCfg.config.rules : []
  const projectRules = projectCfg.status === "valid" ? projectCfg.config.rules : []
  // RC-04b H11: categoryOverrides 接线（user 配置优先，project 覆盖之）
  const userOverrides = userCfg.status === "valid" ? userCfg.config.categoryOverrides : undefined
  const projectOverrides = projectCfg.status === "valid" ? projectCfg.config.categoryOverrides : undefined
  permissionGate.loadRules(userRules, projectRules, { ...projectOverrides, ...userOverrides })
  if (userCfg.status === "invalid" || projectCfg.status === "invalid") {
    const bad = userCfg.status === "invalid" ? "~/.orcana/permissions.json" : "<root>/.orcana/permissions.json"
    const err = userCfg.status === "invalid" ? userCfg.error : (projectCfg.status === "invalid" ? projectCfg.error : "")
    permissionGate.enterSafeMode(`permission 配置损坏（${bad}: ${err}）—— 写入/进程/网络/MCP 全部 ask，用户规则暂停生效`)
  }
  // Sandbox init — shared Job Object for all shell commands in this agent run.
  // H3: the harness may inject its run-scoped sandbox so a run has a single
  // owner; otherwise created here with the same defaults.
  const sandbox = options.sandbox ?? new SandboxManager({
    projectRoot,
    maxRuntimeSec: Number(process.env.ORCANA_SANDBOX_TIMEOUT_SEC) || 30,
    jobMemoryLimitMb: process.env.ORCANA_SANDBOX_MEMORY_MB ? Number(process.env.ORCANA_SANDBOX_MEMORY_MB) : 512,
  })
  setShellSandbox(sandbox)
  // PR 8: set active mode contract from options (defaults to "coder")
  setActiveMode(options.activeMode ?? "coder")
  const pmode: "full" | "strict" = process.env.ORCANA_PERMISSION_MODE === "strict" ? "strict" : "full"
  const toolLedger = new ToolExecutionLedger()
  // GATE-05: GateOverflow 已删除（断环职责并入 ProgressGovernor）——
  // deferredGateMessages 保留给 revise-plan 等通用延迟消息。
  const deferredGateMessages: string[] = []
  // GATE-03 v2: run-scoped liveness fact engine — one governor per run（GS-P1~P6 配置）。
  const progressGovernor = new ProgressGovernor(resolveProgressConfig())
  // IC04: LoopSupervisor 拥有 ProgressGovernor —— liveness decision authority。
  const loopSupervisor = new LoopSupervisor(progressGovernor)
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
    provider: coordinatedProvider,
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
    deferredGateMessages,
    sm,
    progressGovernor,
    loopSupervisor,
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
