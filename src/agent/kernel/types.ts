/** Agent Kernel phase contracts (ALK PR-L7).
 *
 *  LoopDecision — the single control-flow value every phase returns. The
 *  orchestrator (loop.ts) pattern-matches it once, in the terminal switch,
 *  and every exit routes through `finalizeRun()` + the unified `finally`.
 *
 *  RunEffect — the single emission channel used by phase generators
 *  (prepareRun / runRound). It unifies the three side channels the kernel
 *  owns:
 *    - "stream"  → StreamEvent yielded to the consumer (TUI/CLI);
 *    - "trace"   → runTrace.record() entries;
 *    - "state"   → field-level commits to AgentRunState via
 *                  applyAgentRunStatePatch().
 *
 *  Commit boundary (documented deviation from a blanket patch-everything):
 *  section-field commits go through RunEffect "state". Container mutations of
 *  runState-owned objects that are captured by reference (usage, epochState,
 *  taskFiles, rawMessages, lifecycle) and mutations made by controller
 *  modules (MasterPlan controller, L4–L6 coordinators, which own the section
 *  objects they receive) stay in-place so object identity is preserved.
 */

import type { LLMProvider, ProviderMessage, StreamEvent } from "../../provider/types"
import type { ToolDescriptor } from "../../tools/registry"
import type { StagedContextManager } from "../../context/staged"
import type { ThinkingStore } from "../../memory/thinking-store"
import type { KnowledgeBase } from "../../memory/knowledge"
import type { HookSystem } from "../../hooks"
import type { AgentRunTrace } from "../run-trace"
import type { ModelRouter } from "../../provider/router"
import type { UILanguage } from "../language"
import type { RoundState as RouterState } from "../router"
import type { CacheTracker } from "../../provider/cache-tracker"
import type { ContextKernel } from "../../context/kernel"
import type { ErrorTracker } from "../round/pre-loop"
import type { ResearchRouteDecision } from "../research-router"
import type { FlashTriageResult } from "../flash-triage"
import type { IntentPolicy } from "../intent"
import type { ConfidenceEvaluator } from "../../evaluator/confidence"
import type { FlashJudge, TestimonyLedger } from "../flash-judge"
import type { PermissionGate } from "../permission"
import type { SandboxManager } from "../../sandbox/sandbox"
import type { ToolExecutionLedger } from "../tool-ledger"
import type { StateMachine } from "../state-machine"
import type { EpochState } from "../context-epoch"
import type { ContextMap as RuntimeContextMap } from "../../context/context-map"
import type { PlanStore } from "../run/plan-store"
import type {
  AgentRunLifecycleState,
  AgentRunState,
} from "../run/types"
import type { AgentRunStatePatch } from "../run/state-patch"
import type { GateTelemetry } from "../gates/telemetry"
import type { UsageStats, AgentOptions } from "../loop-types"
import type { EvidenceLedger } from "../evidence-ledger"
import type { ProgressGovernor } from "./progress-governor"

export type { AgentRunStatePatch }

/** Why the round loop ended. "break" routes to the shared completed terminal;
 *  "return" routes to the aborted/blocked terminal. */
export type LoopDecision =
  | { kind: "continue" }
  | {
      kind: "break"
      reason:
        | "round_budget" // natural loop end (may carry the budget-exhausted message)
        | "context_budget" // hard context budget block
        | "provider_failure" // non-recoverable provider failure
        | "orchestrator_plan_ready" // completion gate: plan ready pause
        | "orchestrator_blocked" // completion gate: blocked
        | "orchestrator_done" // completion gate: verified done
        | "empty_round" // no tool calls and no final text
        | "self_edit" // runtime self-edit gate break
        | "verified_write" // completion gate text verified stop
        | "progress_stalled" // GATE-03: ProgressGovernor — 4 no-progress rounds
    }
  | {
      kind: "return"
      reason:
        | "aborted" // abort signal (start or mid-round) or consumer close
        | "prompt_blocked" // UserPromptSubmit hook blocked
        | "clarification" // clarification gate asked the user
        | "tool_batch_aborted" // tool batch aborted mid-execution
      blockReason?: string // prompt_blocked detail, emitted as the error event
    }

export type RunEffect =
  | { kind: "stream"; event: StreamEvent }
  | { kind: "trace"; type: string; data?: unknown }
  | { kind: "state"; patch: AgentRunStatePatch }

/** Run-scoped context threaded through prepare → round → finalize.
 *  Owned instances live here so phase modules never hold module-level state. */
export interface RunPhaseContext {
  options: AgentOptions
  provider: LLMProvider
  model: string
  tools: ToolDescriptor[]
  hooks?: HookSystem
  abortSignal?: AbortSignal
  maxRounds: number
  stagedContext?: StagedContextManager
  thinkingStore?: ThinkingStore
  knowledgeBase?: KnowledgeBase
  modelRouter?: ModelRouter
  runTrace?: AgentRunTrace
  gateTelemetry: GateTelemetry
  gateTelemetryFile?: string
  prompt: string
  effectivePrompt: string
  language: UILanguage
  langInstruction: string
  rawMessages: ProviderMessage[]
  /** L1 ownership: Router State is the legacy behavior driver. */
  state: RouterState
  cacheTracker: CacheTracker
  errorTracker: ErrorTracker
  contextKernel: ContextKernel
  researchDecision: ResearchRouteDecision
  experienceContext: string
  triageResult: FlashTriageResult | null
  runState: AgentRunState
  // L1 compatibility references into runState (sections are never replaced).
  planning: AgentRunState["planning"]
  execution: AgentRunState["execution"]
  verificationState: AgentRunState["verification"]
  budget: AgentRunState["budget"]
  notices: AgentRunState["notices"]
  maintenance: AgentRunState["maintenance"]
  intentPolicy: IntentPolicy
  evidenceLedger: EvidenceLedger
  triageSkillPrompts: string[]
  planStore: PlanStore
  /** H8: harness-owned artifact store (verification binds artifacts when present). */
  artifactStore?: import("../../harness/contracts/artifact").ArtifactStore
  /** H8: run id stamped on artifacts produced inside the kernel. */
  runId?: string
  /** H9: capability registry (tool executions route through the executor). */
  capabilityRegistry?: import("../../harness/contracts/capability").CapabilityRegistry
  confidenceEvaluator: ConfidenceEvaluator
  flashJudge: FlashJudge
  testimonyLedger: TestimonyLedger
  permissionGate: PermissionGate
  sandbox: SandboxManager
  pmode: "full" | "strict"
  toolLedger: ToolExecutionLedger
  deferredGateMessages: string[]
  sm: StateMachine
  /** GATE-03: run-scoped liveness controller (STALLED after 4 no-progress rounds). */
  progressGovernor: ProgressGovernor
  /** Context Map (acquired in prepare, consumed by round/master-plan). */
  contextMap: {
    runtimeContextMap: RuntimeContextMap | null
    contextMapContext: string
    contextReadinessBlockers: string[]
    contextReadinessBlocked: boolean
    planContextAttachment: { contextMapId: string; requiredContextEvidence: string[] } | undefined
  }
  CONTEXT_MAX: number
  cacheStableTools: boolean
  taskFiles: Set<string>
  usage: UsageStats
  epochState: EpochState
  lifecycle: AgentRunLifecycleState
}
