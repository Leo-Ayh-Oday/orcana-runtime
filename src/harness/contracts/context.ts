/**
 * H10: Context Provider Pipeline contract (plan §16).
 *
 * Context providers contribute layered, budgeted context instead of each
 * source inserting itself into the message list arbitrarily (§16.5). The
 * pipeline collects → dedupes → validates freshness → sorts by layer →
 * allocates budget → trims → produces a ContextSlice.
 *
 * The contract references stable agent-side types (PlanStateInput,
 * StagedContextManager, TaskTracker, …) because ContextRequest is the
 * kernel-facing request shape — the same precedent as legacy-loop-adapter
 * importing loop types. It never imports src/agent/loop.ts.
 */

import type { ProviderMessage } from "../../provider/types"
import type { ContextKernel } from "../../context/kernel"
import type { StagedContextManager } from "../../context/staged"
import type { ThinkingStore } from "../../memory/thinking-store"
import type { KnowledgeBase } from "../../memory/knowledge"
import type { PlanStateInput, EpochState } from "../../agent/context-epoch"
import type { TaskTracker } from "../../agent/task-tracker"
import type { ModeContract } from "../../agent/mode-contract"

/** Context layer ordering — stable first (cache prefix), volatile last. */
export type ContextLayer = "stable" | "plan" | "node" | "volatile"

export const LAYER_ORDER: readonly ContextLayer[] = ["stable", "plan", "node", "volatile"]

/** One provider's contribution to the pipeline (§16.2). */
export interface ContextContribution {
  providerId: string
  layer: ContextLayer
  /** Provider priority copied onto the contribution — the pipeline sorts and
   *  group-assembles parts by it (the §16.2 original lacks it, H10 extends). */
  priority: number
  /** Empty content = metadata-only contribution (no message produced). */
  content: string
  estimatedTokens: number
  sourceRefs: string[]
  cacheKey?: string
  required: boolean
  freshness?: number
  /**
   * H10 extension: contributions sharing a group are merged into ONE message
   * by the assembler, parts ordered by priority (e.g. the stable prefix
   * group, the volatile round group).
   */
  group?: string
}

/** A context source (§16.1). provide() is async per contract; all first-batch
 *  providers are synchronous wrappers over existing builders. */
export interface ContextProvider {
  id: string
  layer: ContextLayer
  priority: number
  cacheable: boolean
  provide(request: ContextRequest): Promise<ContextContribution>
}

/** Kernel-facing request passed to every provider. */
export interface ContextRequest {
  round: number
  effectivePrompt: string
  contextMax: number
  langInstruction: string
  /** Frozen stable prefix from run 0 — the byte-authoritative source for
   *  rounds ≥ 1 (never rebuilt inside the pipeline, plan §23 cache stability). */
  frozenStablePrefixContent: string | null
  stableMemoryContext?: string
  experienceContext?: string
  contextKernel: ContextKernel
  contextMapContext: string
  triageSkillPrompts: string[]
  planState: PlanStateInput
  researchContextContent: string | null
  stagedContext?: StagedContextManager
  thinkingStore?: ThinkingStore
  knowledgeBase?: KnowledgeBase
  taskTracker: TaskTracker | null
  mode: ModeContract
  rawMessages: ProviderMessage[]
  epochState: EpochState
}

/** §16.5 budget policy. When disabled the pipeline keeps every contribution
 *  (byte-frozen path — the current loop has no context trimming). */
export interface ContextBudgetPolicy {
  enabled: boolean
  maxTokensByLayer?: Partial<Record<ContextLayer, number>>
  maxTotalTokens?: number
}

/** Why a contribution was dropped from the final slice. */
export interface ContextTrimInfo {
  providerId: string
  reason: "duplicate" | "stale" | "budget"
  detail?: string
}

/** Final pipeline output — also the future NodeExecutionContext.context input (H11 §17.3). */
export interface ContextSlice {
  /** Ordered final contributions (metadata-only included). */
  contributions: ContextContribution[]
  byProvider: Map<string, ContextContribution>
  dropped: ContextTrimInfo[]
  budget: {
    allocatedTokens: Partial<Record<ContextLayer, number>>
    totalTokens: number
    trimmedTokens: number
  }
  /** Ordered cacheKeys of the stable prefix (Cache Key stability test surface). */
  cachePrefixKeys: string[]
  warnings: string[]
}

export interface ContextPipelineOptions {
  providers: ContextProvider[]
  request: ContextRequest
  /** undefined → disabled → byte-frozen path (no trimming). */
  budget?: ContextBudgetPolicy
  now?: number
  /** Contributions older than this are stale; default Infinity (never). */
  maxContributionAgeMs?: number
}
