/** Model router — purpose-based model selection and thinking budget adaptation.
 *
 *  Replaces hardcoded model strings in loop.ts and other modules.
 *  Thinking budget tiers are now provider-aware: each model's max thinking
 *  budget is looked up from its ModelSpec rather than assuming 8192/16384/32768
 *  (which was DeepSeek-V4-specific).
 *
 *  PR-6.1: Purpose-based routing enabled for cheap sub-calls (flash_triage,
 *  completion_judge, plan_judge, ambiguity_detector) while agent_main stays
 *  session-pinned to preserve prefix cache continuity.
 */

import type { ProviderCallPurpose, ThinkingConfig } from "./types"
import { ProviderRegistry } from "./registry"
import { MultiProvider } from "./multi"
import type { IntentMode } from "../agent/intent"

/** Signals that tell the router to upgrade thinking. */
export interface ThinkingProfile {
  prompt?: string
  intentMode?: IntentMode
  planningPhase?: boolean
  contextUsagePercent?: number
  autoMaxSignals?: {
    consecutiveErrors: number
    modifiedFiles: number
  }
}

/** Purposes that should use a cheap model (fast, no thinking needed). */
const CHEAP_PURPOSES: ReadonlySet<ProviderCallPurpose> = new Set([
  "flash_triage",
  "completion_judge",
  "plan_judge",
  "ambiguity_detector",
  "thinking_compaction",
  "semantic_recall_score",
  "knowledge_distill",
  "cold_memory_audit",
])

export class ModelRouter {
  private registry: ProviderRegistry
  private multi: MultiProvider
  /** Session-pinned model ID: resolved once at startup, never changes. */
  private sessionModel: string
  /** Cached cheap model ID — resolved lazily. */
  private _cheapModel: string | null = null
  /** Whether purpose-based routing is enabled (default: true for cheap purposes). */
  private purposeRoutingEnabled: boolean

  constructor(
    registry: ProviderRegistry,
    multi: MultiProvider,
    opts?: { purposeRouting?: boolean },
  ) {
    this.registry = registry
    this.multi = multi
    this.sessionModel = multi.resolveForCall().modelId
    this.purposeRoutingEnabled = opts?.purposeRouting ?? true
  }

  /** Select model for a given purpose.
   *
   *  PR-6.1: Cheap sub-calls (flash_triage, completion_judge, plan_judge,
   *  ambiguity_detector, thinking_compaction, semantic_recall_score,
   *  knowledge_distill, cold_memory_audit) are routed to the cheapest
   *  available fast model. The main agent loop stays on the session-pinned
   *  model to preserve prefix cache continuity.
   */
  selectForPurpose(purpose: ProviderCallPurpose): string {
    if (this.purposeRoutingEnabled && CHEAP_PURPOSES.has(purpose)) {
      return this.getCheapModel()
    }
    return this.sessionModel
  }

  /** Get the session-pinned model (for agent_main and other primary calls). */
  getSessionModel(): string {
    return this.sessionModel
  }

  /** Update the primary session model after /models changes selection. */
  setSessionModel(modelId: string): void {
    this.sessionModel = modelId
    this._cheapModel = null
  }

  /** Get the cheap model for non-essential sub-calls.
   *
   *  Prefers a "fast"-tagged cheap model from the same provider as the
   *  session model. Falls back to any fast model, then session model.
   */
  getCheapModel(): string {
    if (this._cheapModel) return this._cheapModel

    const sessionSpec = this.registry.resolveModel(this.sessionModel)
    const sessionProvider = sessionSpec?.providerId

    // Prefer same-provider cheap model
    if (sessionProvider) {
      const sameProviderCheap = this.registry.listModelsByTier("cheap")
        .filter(id => {
          const spec = this.registry.resolveModel(id)
          return spec && spec.providerId === sessionProvider && spec.tags.includes("fast")
        })
      const match = sameProviderCheap[0]
      if (match) {
        this._cheapModel = match
        return match
      }
    }

    // Fallback: any cheap fast model
    const cheap = this.registry.findCheapest(["fast"])
    this._cheapModel = cheap ?? this.sessionModel
    return this._cheapModel
  }

  /** Resolve a model ID to its full spec (for capability checks). */
  resolveModel(modelId: string) {
    return this.registry.resolveModel(modelId)
  }

  /** Adapt thinking config to the selected model's capability. */
  adaptThinking(
    modelId: string,
    baseThinking: ThinkingConfig | undefined,
    profile?: ThinkingProfile,
  ): ThinkingConfig | undefined {
    if (!baseThinking) return undefined

    const spec = this.registry.resolveModel(modelId)
    if (!spec || !spec.thinking.supported) return undefined

    const capability = spec.thinking

    if (capability.mode === "adaptive") {
      const forceMax =
        profile?.intentMode !== "readonly" &&
        profile?.autoMaxSignals &&
        (profile.autoMaxSignals.consecutiveErrors >= 3 || profile.autoMaxSignals.modifiedFiles >= 5)
      return { type: "adaptive", effort: forceMax ? "max" : baseThinking.effort ?? "high" }
    }

    // Force max thinking on error cascades or broad edits
    const forceMax =
      profile?.intentMode !== "readonly" &&
      profile?.autoMaxSignals &&
      (profile.autoMaxSignals.consecutiveErrors >= 3 || profile.autoMaxSignals.modifiedFiles >= 5)

    let budget = baseThinking.budget_tokens ?? capability.defaultBudget ?? 16384
    if (forceMax) {
      budget = capability.maxBudgetTokens ?? 32768
    }
    if (budget && capability.maxBudgetTokens) {
      budget = Math.min(budget, capability.maxBudgetTokens)
    }

    let effort = forceMax ? "max" : baseThinking.effort ?? "high"
    if (!capability.effortLevels.includes(effort)) {
      effort = capability.effortLevels[0] ?? "high"
    }

    return {
      type: "enabled",
      budget_tokens: budget,
      effort,
    }
  }

  /** Get the thinking budget tiers for the current model. */
  getThinkingTiers(modelId: string): { low: number; medium: number; high: number; max: number } {
    const spec = this.registry.resolveModel(modelId)
    const max = spec?.thinking.maxBudgetTokens ?? 32768
    return {
      low: Math.floor(max / 4),
      medium: Math.floor(max / 2),
      high: Math.floor(max * 0.75),
      max,
    }
  }

  /** Get context window for a model. */
  getContextWindow(modelId: string): number {
    const spec = this.registry.resolveModel(modelId)
    return spec?.contextWindow ?? 1_048_576
  }

  /** Check if a purpose should use a cheap model. */
  static isCheapPurpose(purpose: ProviderCallPurpose): boolean {
    return CHEAP_PURPOSES.has(purpose)
  }
}

/** Convenience: build the full provider stack.
 *
 *  registry = new ProviderRegistry()
 *  register providers + models
 *  multi = new MultiProvider({ registry, defaultModel: "deepseek-v4-pro" })
 *  router = new ModelRouter(registry, multi)
 */
export function createProviderStack(
  registrations: Array<{
    id: string
    provider: import("./types").LLMProvider
    defaultModel: string
    toolAdapter?: import("./types").ToolSchemaAdapter
  }>,
  defaultModel: string,
): { registry: ProviderRegistry; multi: MultiProvider; router: ModelRouter } {
  const registry = new ProviderRegistry()
  for (const reg of registrations) {
    registry.register({
      id: reg.id,
      provider: reg.provider,
      defaultModel: reg.defaultModel,
      toolAdapter: reg.toolAdapter,
    })
  }
  registry.registerBuiltinModels()

  const multi = new MultiProvider({ registry, defaultModel })
  const router = new ModelRouter(registry, multi)

  return { registry, multi, router }
}
