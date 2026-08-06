import type { LLMProvider } from "../provider/types"
import type { ToolDescriptor } from "../tools/registry"
import type { StagedContextManager } from "../context/staged"
import type { ThinkingStore } from "../memory/thinking-store"
import type { KnowledgeBase } from "../memory/knowledge"
import type { HookSystem } from "../hooks"
import type { AgentRunTrace } from "./run-trace"
import type { SessionCheckpoint } from "../session/checkpoint"
import type { ModeName } from "./mode-contract"
import type { PlanStore } from "./run/plan-store"

export interface UsageStats {
  apiCalls: number
  estimatedInputTokens: number
  cacheHits: number
  cacheMisses: number
  flashRounds: number
  proRounds: number
  flashUsed: boolean
}

export interface AgentOptions {
  provider: LLMProvider
  model: string
  tools: ToolDescriptor[]
  /** Cancels the whole agent run and is bridged to the currently active provider stream. */
  abortSignal?: AbortSignal
  /** RT-3: explicit project root — kernel tools/paths resolve against it
   *  instead of process.cwd() (the harness always passes the run scope root). */
  projectRoot?: string
  maxRounds?: number
  /** Active model context window; defaults to DeepSeek V4's 1M for legacy callers. */
  contextMaxTokens?: number
  /** K6: 角色含 "system"——resume 权威约束帧（buildResumeMessages 产物）可进入历史。 */
  conversationHistory?: Array<{ role: "user" | "assistant" | "system"; content: string }>
  stagedContext?: StagedContextManager
  thinkingStore?: ThinkingStore
  knowledgeBase?: KnowledgeBase
  thinkEffort?: "high" | "max"
  hooks?: HookSystem
  autoFinishOnVerifiedWrite?: boolean
  runTrace?: AgentRunTrace
  stableMemoryContext?: string
  autoApprovePlan?: boolean
  modelRouter?: import("../provider/router").ModelRouter
  sessionId?: string
  /** D4 (CHECKPOINT_RESUME_USED): checkpoint 快照，buildRunContext 消费
   *  （恢复提示 system 消息注入 + masterPlan/taskTracker 水合）。 */
  resumeFromCheckpoint?: SessionCheckpoint
  /** Optional: gate telemetry collector for the 3-step validation plan. */
  gateTelemetry?: import("./gates/telemetry").GateTelemetry
  /** Optional: file path to auto-save telemetry on agent exit. */
  gateTelemetryFile?: string
  /** Set to "approved" when re-invoking after user approved the plan (replaces [PLAN_APPROVED] message protocol). */
  initialPlanState?: "approved"
  /** Override Flash Triage policy for this run ("off" | "auto" | "always"). */
  flashTriagePolicy?: "off" | "auto" | "always"
  /** Plan text from a prior plan_ready event — passed back by CLI when user approves the plan.
   *  Prevents losing the plan text across agentLoop invocations in the user-approval flow. */
  planText?: string
  /** PR 8: Active mode contract for role discipline. Defaults to "coder". */
  activeMode?: ModeName
  /** ContextMap acquisition policy. "auto" builds maps for long/high-risk tasks. */
  contextMapPolicy?: "off" | "auto" | "always"
  /** PR-7.2: Context injected by SessionStart hook handlers (e.g., project rules). */
  sessionStartContext?: string
  /** L2: optional caller-provided run-scoped plan owner. */
  planStore?: PlanStore
  /** H3: optional caller-provided run-scoped sandbox (single ownership with the harness). */
  sandbox?: import("../sandbox/sandbox").SandboxManager
  /** H8: optional caller-provided run-scoped artifact store (single ownership
   *  with the harness). When present, verification produces bound artifacts. */
  artifactStore?: import("../harness/contracts/artifact").ArtifactStore
  /** R1 (Harness Closure): optional caller-provided run-scoped evidence
   *  ledger — same single-ownership pattern as planStore/sandbox/artifactStore.
   *  When absent the kernel creates its own (unchanged behavior). */
  evidenceLedger?: import("../agent/evidence-ledger").EvidenceLedger
  /** H8: run id stamped on artifacts produced inside the kernel. */
  runId?: string
  /** H9: capability registry — the loop's tool executions route through the
   *  CapabilityExecutor with this registry (shared with the Node Runtime). */
  capabilityRegistry?: import("../harness/contracts/capability").CapabilityRegistry
}
