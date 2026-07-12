import type { LLMProvider } from "../provider/types"
import type { ToolDescriptor } from "../tools/registry"
import type { StagedContextManager } from "../context/staged"
import type { ThinkingStore } from "../memory/thinking-store"
import type { KnowledgeBase } from "../memory/knowledge"
import type { HookSystem } from "../hooks"
import type { AgentRunTrace } from "./run-trace"
import type { SessionCheckpoint } from "../session/checkpoint"
import type { ModeName } from "./mode-contract"

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
  maxRounds?: number
  /** Active model context window; defaults to DeepSeek V4's 1M for legacy callers. */
  contextMaxTokens?: number
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>
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
}
