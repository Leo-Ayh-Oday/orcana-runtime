import type { ProviderMessage, ProviderTokenUsage } from "../../provider/types"
import type { RippleObligation } from "../../ripple/obligations"
import type { RippleReport } from "../../ripple/types"
import type { VerificationResult } from "../../verification/result"
import type { EpochState } from "../context-epoch"
import type { EvidenceLedger } from "../evidence-ledger"
import type { IntentPolicy } from "../intent"
import type { ResearchEvidence } from "../research-answer"
import type { TaskTracker } from "../task-tracker"
import type { UILanguage } from "../language"
import type { UsageStats } from "../loop-types"
import type { PlanStore } from "./plan-store"

export type AgentRunStopReason = "completed" | "aborted" | "error" | "blocked" | "stalled" | "paused"

export interface AgentRunLifecycleState {
  startedAt: number
  finalRound: number
  stopReason: AgentRunStopReason
  stopHookDispatched: boolean
  reachedRoundBudget: boolean
}

export interface AgentRunState {
  identity: {
    runId: string
    sessionId?: string
    prompt: string
    effectivePrompt: string
    language: UILanguage
  }

  conversation: {
    rawMessages: ProviderMessage[]
    frozenStablePrefix: ProviderMessage | null
    stablePrefixHash: string
  }

  planning: {
    intentPolicy: IntentPolicy
    taskTracker: TaskTracker | null
    /** L2 canonical owner for the active MasterPlan reference. */
    planStore: PlanStore
    planApproved: boolean
    planningRejections: number
    lastPlanText: string
  }

  research: {
    context: ProviderMessage | null
    evidence: ResearchEvidence[]
    skillPrompts: string[]
  }

  execution: {
    taskHadWrite: boolean
    toolErrors: number
    modifiedFileCount: number
    consecutiveErrors: number
    requestedMaxThinking: boolean
    runtimeSelfEditFiles: Set<string>
    /** TB2-1: 观察过（读/发现）的文件——与 modifiedFiles 分开，只读不算修改。 */
    taskFiles: Set<string>
    /** TB2-1: 写工具实际成功修改的文件（完成判定/checkpoint/报告的权威来源）。 */
    modifiedFiles: Set<string>
    /** TB2-1: 工具协议错误受约束恢复中——下一轮压低 thinking budget。 */
    protocolRecoveryActive: boolean
    lastToolNames: string[]
    rippleBlockActive: boolean
  }

  verification: {
    /**
     * Canonical verification fact source. Compatibility projections such as
     * lastTypecheck and TaskTracker.verificationEvidence must be derived from
     * results or this ledger and must not become independent completion facts.
     */
    evidenceLedger: EvidenceLedger
    rippleObligations: RippleObligation[]
    lastResults: VerificationResult[]
    lastTypecheck?: { passed: boolean; issues: number; output?: string; status?: string }
    lastRippleReports: RippleReport[]
  }

  budget: {
    usage: UsageStats
    contextInput: number
    contextOutput: number
    epoch: EpochState
    thinkingTokens: number
    microcompactCount: number
  }

  notices: {
    announcedKernel: boolean
    webSearchFailedThisTurn: boolean
    webSearchFailReason: string
    announcedContextDegraded: boolean
    announcedEpochForceCompress: boolean
  }

  maintenance: {
    thinkingCompacted: boolean
  }

  lifecycle: AgentRunLifecycleState
}

export interface ThinkingBlock {
  thinking: string
  signature: string
}

export interface RoundToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ProviderFailure {
  message: string
  retryable: boolean
  yielded: boolean
  /** TB2-1: 类型化工具协议/传输失败分类（tool_protocol_invalid_json 等）。 */
  kind?: string
}

export interface RoundState {
  round: number
  startedAt: number
  finalText: string
  textChunks: string[]
  thinkingBlocks: ThinkingBlock[]
  toolCalls: RoundToolCall[]
  providerUsage: ProviderTokenUsage | null
  providerFailure?: ProviderFailure
  bufferedTextEmitted: boolean

  toolNames: string[]
  filePaths: string[]
  toolResults: Array<Record<string, unknown>>
  learnPrompts: string[]
  modifiedFiles: Set<string>
  rippleReports: RippleReport[]
  verificationResults: VerificationResult[]
  hadToolError: boolean
  completionGateText: string
  narrowEditEvidenceBlocked: boolean
  verificationPassed: boolean
  serviceTestGuidanceNeeded: boolean
  rateLimits: {
    shell: number
    file: number
    network: number
  }
}

/**
 * L1 ownership decision:
 * - Router State remains the legacy behavior driver for thinking/routing.
 * - StateMachine remains a monitoring and transition-validation projection.
 * - AgentRunState owns durable mutable run facts.
 *
 * Router State and StateMachine are intentionally not embedded here; doing so
 * would create competing sources of truth before their later migration phase.
 */
export const L1_STATE_OWNERSHIP = {
  agentRunState: "durable-run-facts",
  routerState: "legacy-behavior-driver",
  stateMachine: "readonly-monitor",
} as const
