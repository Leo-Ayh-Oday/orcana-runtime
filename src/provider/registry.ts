/** Provider Registry — stores LLMProvider instances and ModelSpec metadata.
 *
 *  Runtime index for all available models. Model metadata is derived from the
 *  canonical config catalog and any user overrides; the registry owns:
 *    - Provider instances (keyed by ProviderID)
 *    - Model metadata (keyed by ModelID)
 *    - Default models per tier / purpose
 *
 *  This replaces the hardcoded "deepseek-v4-pro" / "deepseek-v4-flash"
 *  strings scattered across the codebase.
 */

import type {
  LLMProvider,
  ModelCapabilities,
  ModelID,
  ModelSpec,
  PricingTier,
  ProviderID,
  ProviderRegistration,
  ResolvedModel,
} from "./types"
import { builtInProviders } from "../config/config-schema"
import { toModelSpec } from "./capabilities"

// ── Registry ──

export class ProviderRegistry {
  private providers = new Map<ProviderID, ProviderRegistration>()
  private models = new Map<ModelID, ModelSpec>()
  private aliases = new Map<ModelID, ModelID>()

  // ── Registration ──

  /** Register a provider instance with its metadata. */
  register(reg: ProviderRegistration): void {
    if (this.providers.has(reg.id)) {
      throw new Error(`ProviderRegistry: duplicate provider '${reg.id}'`)
    }
    this.providers.set(reg.id, reg)
  }

  /** Register or replace a provider instance. Used by TUI auth setup after a key is saved. */
  upsertProvider(reg: ProviderRegistration): void {
    this.providers.set(reg.id, reg)
  }

  /** Register model metadata. Must have a matching provider registered. */
  registerModel(spec: ModelSpec): void {
    if (!this.providers.has(spec.providerId)) {
      throw new Error(
        `ProviderRegistry: model '${spec.id}' references unregistered provider '${spec.providerId}'`,
      )
    }
    this.models.set(spec.id, spec)
  }

  /** Register an alias (e.g. "sonnet" → "claude-sonnet-4-6"). */
  registerAlias(alias: ModelID, target: ModelID): void {
    this.aliases.set(alias, target)
  }

  /** Register the canonical built-in catalog for providers available in this runtime. */
  registerBuiltinModels(): void {
    for (const [providerId, providerConfig] of Object.entries(builtInProviders)) {
      if (!this.providers.has(providerId)) continue
      for (const [modelId, modelConfig] of Object.entries(providerConfig.models)) {
        this.models.set(modelId, toModelSpec(modelId, providerId, modelConfig, providerConfig))
      }
    }
  }

  // ── Resolution ──

  /** Resolve a model ID (with alias support) to its spec. */
  resolveModel(id: ModelID): ModelSpec | undefined {
    const target = this.aliases.get(id) ?? id
    return this.models.get(target)
  }

  /** Resolve a model ID to a fully-resolved model (provider + spec). */
  resolve(id: ModelID): ResolvedModel | undefined {
    const spec = this.resolveModel(id)
    if (!spec) return undefined
    const reg = this.providers.get(spec.providerId)
    if (!reg) return undefined
    return {
      providerId: reg.id,
      provider: reg.provider,
      modelId: spec.id,
      spec,
      toolAdapter: reg.toolAdapter,
    }
  }

  /** Resolve with a fallback if the primary isn't available. */
  resolveOrFallback(id: ModelID, fallbackId: ModelID): ResolvedModel | undefined {
    return this.resolve(id) ?? this.resolve(fallbackId)
  }

  // ── Query ──

  /** Get a provider by ID. */
  getProvider(id: ProviderID): LLMProvider | undefined {
    return this.providers.get(id)?.provider
  }

  /** Get a provider registration. */
  getRegistration(id: ProviderID): ProviderRegistration | undefined {
    return this.providers.get(id)
  }

  /** Get default model for a provider. */
  getDefaultModel(providerId: ProviderID): ModelID | undefined {
    return this.providers.get(providerId)?.defaultModel
  }

  /** List all registered model IDs. */
  listModels(): ModelID[] {
    return [...this.models.keys()].sort()
  }

  /** List models by pricing tier. */
  listModelsByTier(tier: PricingTier): ModelID[] {
    return [...this.models.values()]
      .filter(spec => spec.pricingTier === tier)
      .map(spec => spec.id)
      .sort()
  }

  /** List models by tag. */
  listModelsByTag(tag: string): ModelID[] {
    return [...this.models.values()]
      .filter(spec => spec.tags.includes(tag))
      .map(spec => spec.id)
      .sort()
  }

  /** Find the cheapest model that satisfies the given tags. */
  findCheapest(tags: string[]): ModelID | undefined {
    const tierOrder: PricingTier[] = ["free", "cheap", "standard", "premium"]
    for (const tier of tierOrder) {
      const candidates = this.listModelsByTier(tier).filter(id => {
        const spec = this.models.get(id)
        return spec && tags.every(tag => spec.tags.includes(tag))
      })
      if (candidates.length > 0) return candidates[0]
    }
    return undefined
  }

  /** List all registered provider IDs. */
  listProviders(): ProviderID[] {
    return [...this.providers.keys()].sort()
  }

  /** Check if a model exists and is registered. */
  hasModel(id: ModelID): boolean {
    return this.models.has(this.aliases.get(id) ?? id)
  }

  // ── Capability queries (PR-6.2) ──

  /** Get capabilities for a specific model. */
  getCapabilities(modelId: ModelID): ModelCapabilities | undefined {
    const spec = this.resolveModel(modelId)
    return spec?.capabilities
  }

  /** Get provider-level capabilities (union of all registered models for that provider). */
  getProviderCapabilities(providerId: ProviderID): ModelCapabilities | undefined {
    return this.providers.get(providerId)?.capabilities
  }

  /** List models that satisfy ALL given capability requirements. */
  listModelsByCapability(required: Partial<ModelCapabilities>): ModelID[] {
    return [...this.models.values()]
      .filter(spec => {
        const cap = spec.capabilities
        for (const [key, value] of Object.entries(required)) {
          if (value !== undefined && (cap as unknown as Record<string, unknown>)[key] !== value) {
            return false
          }
        }
        return true
      })
      .map(spec => spec.id)
      .sort()
  }

  /** Check if a model satisfies all given capability requirements. */
  modelHasCapability(modelId: ModelID, required: Partial<ModelCapabilities>): boolean {
    const cap = this.getCapabilities(modelId)
    if (!cap) return false
    for (const [key, value] of Object.entries(required)) {
      if (value !== undefined && (cap as unknown as Record<string, unknown>)[key] !== value) {
        return false
      }
    }
    return true
  }

  get allModels(): ModelSpec[] {
    return [...this.models.values()]
  }

  get allRegistrations(): ProviderRegistration[] {
    return [...this.providers.values()]
  }
}
