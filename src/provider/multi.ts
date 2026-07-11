/** MultiProvider — LLMProvider adapter that routes to registered providers.
 *
 *  Preserves prefix cache tracking: CacheTracker remains round-level in loop.ts.
 *  Each underlying provider's cache behavior is transparent to the tracker because
 *  the ProviderMessage stream shape (messages array prefix) is independent of
 *  which provider processes it.
 *
 *  Key invariant: streamChat always returns StreamEvent[] with the same shape
 *  regardless of which underlying provider is selected. This keeps loop.ts's
 *  cache prefix detection intact.
 */

import type {
  LLMProvider,
  ProviderCallOptions,
  ResolvedModel,
  StreamEvent,
  ThinkingConfig,
  ToolSchemaAdapter,
} from "./types"
import type { ProviderRegistry } from "./registry"
import { currentCostMode, shouldSkipProviderPurpose, type CostMode } from "./cost-policy"

export interface MultiProviderOptions {
  registry: ProviderRegistry
  /** Default model when none specified (e.g. "deepseek-v4-pro"). */
  defaultModel: string
  /** Fallback model if the default is unavailable. */
  fallbackModel?: string
  /** Optional model override from user config / env. */
  modelOverride?: string
  /** Optional provider override. */
  providerOverride?: string
}

export class MultiProvider implements LLMProvider {
  private registry: ProviderRegistry
  private defaultModel: string
  private fallbackModel: string
  private modelOverride?: string
  private providerOverride?: string
  private costMode: CostMode

  constructor(options: MultiProviderOptions) {
    this.registry = options.registry
    this.defaultModel = options.defaultModel
    this.fallbackModel = options.fallbackModel ?? options.defaultModel
    this.modelOverride = options.modelOverride
    this.providerOverride = options.providerOverride
    this.costMode = currentCostMode()
  }

  /** Refresh cost mode from env (call after env changes). */
  refreshCostMode(): void {
    this.costMode = currentCostMode()
  }

  /** Switch the session model without rebuilding the provider stack. */
  setModelOverride(modelId: string): void {
    this.modelOverride = modelId
  }

  get currentModel(): string {
    return this.modelOverride ?? this.defaultModel
  }

  /** Resolve the model to use for a given call. */
  resolveForCall(purpose?: string): ResolvedModel {
    // 1. User override wins
    if (this.modelOverride) {
      const resolved = this.registry.resolve(this.modelOverride)
      if (resolved) return resolved
    }

    // 2. Default model
    const resolved = this.registry.resolve(this.defaultModel)
    if (resolved) return resolved

    // 3. Fallback
    const fallback = this.registry.resolve(this.fallbackModel)
    if (fallback) return fallback

    throw new Error(
      `MultiProvider: no registered provider for '${this.defaultModel}' or fallback '${this.fallbackModel}'`,
    )
  }

  /** Select a model for a specific purpose (respects cost mode). */
  selectModel(purpose?: string): ResolvedModel {
    // Cost-aware downgrade: if strict mode, prefer cheap models for non-essential purposes
    if (this.costMode === "strict" && purpose && shouldSkipProviderPurpose(purpose as never)) {
      const cheap = this.registry.findCheapest(["fast"])
      if (cheap) {
        const resolved = this.registry.resolve(cheap)
        if (resolved) return resolved
      }
    }

    return this.resolveForCall(purpose)
  }

  /** Get the effective thinking config for a model, provider-adapted. */
  thinkingFor(model: ResolvedModel, requestedThinking?: ThinkingConfig): ThinkingConfig | undefined {
    if (!requestedThinking) return undefined
    const capability = model.spec.thinking
    if (!capability.supported) return undefined

    let budget = requestedThinking.budget_tokens ?? capability.defaultBudget
    if (budget && capability.maxBudgetTokens) {
      budget = Math.min(budget, capability.maxBudgetTokens)
    }

    let effort = requestedThinking.effort ?? "high"
    if (!capability.effortLevels.includes(effort)) {
      effort = capability.effortLevels[0] ?? "high"
    }

    return {
      type: "enabled",
      budget_tokens: budget,
      effort,
    }
  }

  // ── LLMProvider implementation ──

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    const resolved = this.registry.resolve(options.model) ?? this.selectModel(options.purpose)
    const provider = resolved.provider

    // Adapt tools if this provider needs schema conversion
    let adaptedTools = options.tools
    if (resolved.toolAdapter?.needsConversion && options.tools) {
      adaptedTools = options.tools.map(t => resolved.toolAdapter!.adapt(t))
    }

    // Adapt thinking to model capability
    const adaptedThinking = this.thinkingFor(resolved, options.thinking)

    // Route to the selected provider
    yield* provider.streamChat({
      ...options,
      model: resolved.modelId,
      tools: adaptedTools,
      thinking: adaptedThinking,
    })
  }

  // ── Convenience ──

  /** Get the default resolved model info for display. */
  get defaultResolved(): ResolvedModel {
    return this.resolveForCall()
  }

  /** List available models for UI display. */
  listAvailableModels(): Array<{ id: string; displayName: string; providerId: string; tier: string }> {
    return this.registry.allModels.map(spec => ({
      id: spec.id,
      displayName: spec.displayName,
      providerId: spec.providerId,
      tier: spec.pricingTier,
    }))
  }
}

/** Adapt tool schema from Anthropic format to OpenAI format.
 *
 *  Anthropic: { name, description, input_schema: { type: "object", properties, required } }
 *  OpenAI:    { type: "function", function: { name, description, parameters: { type: "object", properties, required } } }
 */
export const openaiToolAdapter: ToolSchemaAdapter = {
  needsConversion: true,
  adapt(tool: Record<string, unknown>): Record<string, unknown> {
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema ?? { type: "object", properties: {} },
      },
    }
  },
}

/** No-op adapter for Anthropic-compatible providers. */
export const anthropicToolAdapter: ToolSchemaAdapter = {
  needsConversion: false,
  adapt(tool: Record<string, unknown>): Record<string, unknown> {
    return tool
  },
}
