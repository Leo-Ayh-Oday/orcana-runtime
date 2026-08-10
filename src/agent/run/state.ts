import { createEpochState, type EpochState } from "../context-epoch"
import { createEvidenceLedger, type EvidenceLedger } from "../evidence-ledger"
import type { IntentPolicy } from "../intent"
import type { MasterPlan } from "../master-plan"
import type { ResearchEvidence } from "../research-answer"
import type { TaskTracker } from "../task-tracker"
import type { UILanguage } from "../language"
import type { ProviderMessage } from "../../provider/types"
import type { RippleObligation } from "../../ripple/obligations"
import type { AgentRunLifecycleState, AgentRunState, RoundState } from "./types"
import { createPlanStore, type PlanStore } from "./plan-store"

export interface CreateAgentRunStateInput {
  runId?: string
  sessionId?: string
  prompt: string
  effectivePrompt: string
  language: UILanguage
  rawMessages: ProviderMessage[]
  intentPolicy: IntentPolicy
  taskTracker?: TaskTracker | null
  planStore?: PlanStore
  /** @deprecated Pass planStore. Retained for L1 construction compatibility. */
  masterPlan?: MasterPlan | null
  evidenceLedger?: EvidenceLedger
  rippleObligations?: RippleObligation[]
  skillPrompts?: string[]
  researchEvidence?: ResearchEvidence[]
  epoch?: EpochState
  planApproved?: boolean
  lifecycle?: AgentRunLifecycleState
  now?: () => number
}

function defaultRunId(sessionId: string | undefined, startedAt: number): string {
  return sessionId ? `session:${sessionId}` : `run:${startedAt}`
}

export function createAgentRunState(input: CreateAgentRunStateInput): AgentRunState {
  const startedAt = input.lifecycle?.startedAt ?? input.now?.() ?? Date.now()
  const lifecycle = input.lifecycle ?? {
    startedAt,
    finalRound: 0,
    stopReason: "aborted",
    stopHookDispatched: false,
    reachedRoundBudget: false,
  }

  return {
    identity: {
      runId: input.runId ?? defaultRunId(input.sessionId, startedAt),
      sessionId: input.sessionId,
      prompt: input.prompt,
      effectivePrompt: input.effectivePrompt,
      language: input.language,
    },
    conversation: {
      rawMessages: input.rawMessages,
      frozenStablePrefix: null,
      stablePrefixHash: "",
    },
    planning: {
      intentPolicy: input.intentPolicy,
      taskTracker: input.taskTracker ?? null,
      planStore: input.planStore ?? createPlanStore(input.masterPlan ?? null),
      planApproved: input.planApproved ?? false,
      planningRejections: 0,
      lastPlanText: "",
    },
    research: {
      context: null,
      evidence: input.researchEvidence ?? [],
      skillPrompts: input.skillPrompts ?? [],
    },
    execution: {
      taskHadWrite: false,
      toolErrors: 0,
      modifiedFileCount: 0,
      consecutiveErrors: 0,
      requestedMaxThinking: false,
      runtimeSelfEditFiles: new Set(),
      taskFiles: new Set(),
      modifiedFiles: new Set(),
      protocolRecoveryActive: false,
      lastToolNames: [],
      rippleBlockActive: false,
    },
    verification: {
      evidenceLedger: input.evidenceLedger ?? createEvidenceLedger(),
      rippleObligations: input.rippleObligations ?? [],
      lastResults: [],
      lastRippleReports: [],
    },
    budget: {
      usage: {
        apiCalls: 0,
        estimatedInputTokens: 0,
        cacheHits: 0,
        cacheMisses: 0,
        // H12: cumulative cache-miss input tokens (same invariant as
        // budget.contextInput/contextOutput — see UsageStats).
        cacheMissInputTokens: 0,
        flashRounds: 0,
        proRounds: 0,
        flashUsed: false,
      },
      contextInput: 0,
      contextOutput: 0,
      epoch: input.epoch ?? createEpochState(),
      thinkingTokens: 0,
      microcompactCount: 0,
    },
    notices: {
      announcedKernel: false,
      webSearchFailedThisTurn: false,
      webSearchFailReason: "",
      announcedContextDegraded: false,
      announcedEpochForceCompress: false,
    },
    maintenance: {
      thinkingCompacted: false,
    },
    lifecycle,
  }
}

export function createRoundState(round: number, startedAt = Date.now()): RoundState {
  return {
    round,
    startedAt,
    finalText: "",
    textChunks: [],
    thinkingBlocks: [],
    toolCalls: [],
    providerUsage: null,
    bufferedTextEmitted: false,
    toolNames: [],
    filePaths: [],
    toolResults: [],
    learnPrompts: [],
    modifiedFiles: new Set(),
    rippleReports: [],
    verificationResults: [],
    hadToolError: false,
    completionGateText: "",
    narrowEditEvidenceBlocked: false,
    verificationPassed: false,
    serviceTestGuidanceNeeded: false,
    rateLimits: {
      shell: 0,
      file: 0,
      network: 0,
    },
  }
}
