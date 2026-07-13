/** Provider-agnostic LLM interface — single-provider + multi-provider registry.
 *
 *  PR-6.2: ProviderCapabilities added to ModelSpec and ProviderRegistration
 *  so the system can query what a model/provider supports without hardcoding
 *  provider-specific checks.
 */

export interface ProviderMessage {
  role: "user" | "assistant" | "system"
  content: string | Array<Record<string, unknown>>
}

export interface StreamEvent {
  type: "text" | "tool_call" | "tool_result" | "thinking_blocks" | "status" | "error" | "done" | "confirm" | "token_usage" | "plan_ready" | "task_progress" | "clarification_ready"
  /** For confirm: { tool: string, params: Record<string,unknown>, message: string } */
  data?: unknown
}

export type ProviderCallPurpose =
  | "agent_main"
  | "clarification"
  | "chat_lite"
  | "thinking_compaction"
  | "semantic_recall_score"
  | "knowledge_distill"
  | "flash_triage"
  | "completion_judge"
  | "plan_judge"
  | "ambiguity_detector"
  | "cold_memory_audit"
  | "unknown"

export interface ProviderTokenUsage {
  purpose?: ProviderCallPurpose
  requestedModel?: string
  actualModel?: string
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  cacheMissInputTokens?: number
  cacheHitRate?: number
  outputShare?: number
  missShare?: number
  claudeStyleCacheShape?: boolean
  source?: "provider" | "estimate"
  cachePrefixShape?: {
    firstChangedSection?: string
    sections: Array<{ kind: string; hash: string; chars: number; stable: boolean; changed: boolean }>
  }
}

export interface ThinkingConfig {
  type: "enabled" | "adaptive" | "disabled"
  budget_tokens?: number
  effort?: "high" | "max"
}

/** PR-6.4: Structured output request — JSON Schema or JSON object mode. */
export interface StructuredOutputRequest {
  type: "json_schema" | "json_object"
  /** JSON Schema for json_schema mode. */
  schema?: Record<string, unknown>
  /** Name for the schema (required by some providers). */
  name: string
  /** Whether to enforce strict mode (fail closed). */
  strict?: boolean
}

export interface ProviderCallOptions {
  model: string
  purpose?: ProviderCallPurpose
  system: string
  messages: ProviderMessage[]
  tools?: Array<Record<string, unknown>>
  thinking?: ThinkingConfig
  maxTokens: number
  abortSignal?: AbortSignal
  /** PR-6.4: API-level structured output (response_format). */
  responseFormat?: StructuredOutputRequest
}

export interface LLMProvider {
  streamChat(
    options: ProviderCallOptions,
  ): AsyncGenerator<StreamEvent>
}

// ── Multi-Provider Registry types ──

/** Unique identifier for a provider instance (e.g. "deepseek", "anthropic", "openai"). */
export type ProviderID = string

/** Logical model name — resolved to a specific provider+model at call time. */
export type ModelID = string

/** Pricing tier for cost-aware routing. */
export type PricingTier = "free" | "cheap" | "standard" | "premium"

/** Thinking capability descriptor — what the model supports. */
export interface ThinkingCapability {
  supported: boolean
  mode?: "manual" | "adaptive"
  maxBudgetTokens?: number    // max thinking budget this model accepts
  defaultBudget?: number       // default when router doesn't specify
  effortLevels: Array<"high" | "max">
}

/** What a model can and cannot do — declared statically, checked at runtime.
 *
 *  PR-6.2: Every model declares its capabilities so the system can
 *  query "does this model support FIM?" or "can this provider do
 *  structured output?" without hardcoding provider-specific checks.
 */
export interface ModelCapabilities {
  /** Thinking/reasoning tokens (extended thinking). */
  thinking: boolean
  /** Fill-in-the-middle completions (code infill). */
  fim: boolean
  /** Prompt caching / cache_control breakpoints. */
  contextCaching: boolean
  /** Image/vision input support. */
  vision: boolean
  /** API-level structured output (response_format / JSON mode). */
  structuredOutput: boolean
  /** Native tool/function calling. */
  toolUse: boolean
  /** Streaming SSE support. */
  streaming: boolean
  /** Max context window size (may differ from ModelSpec.contextWindow for practical limits). */
  maxContextWindow: number
}

/** Model metadata — static information stored in the registry. */
export interface ModelSpec {
  id: ModelID
  providerId: ProviderID
  displayName: string
  contextWindow: number
  maxOutputTokens: number
  pricingTier: PricingTier
  thinking: ThinkingCapability
  /** PR-6.2: What this model can and cannot do. */
  capabilities: ModelCapabilities
  /** Tags for purpose-based routing (e.g. "coding", "fast", "vision"). */
  tags: string[]
  /** Whether this model is the default for its tier. */
  isDefault?: boolean
}

/** Provider registration — binds a provider instance to its metadata. */
export interface ProviderRegistration {
  id: ProviderID
  provider: LLMProvider
  /** Provider-specific tool schema adapter (Anthropic vs OpenAI format). */
  toolAdapter?: ToolSchemaAdapter
  /** Default model for this provider (used when none specified). */
  defaultModel: ModelID
  /** PR-6.2: Provider-level capabilities (union of all registered models). */
  capabilities?: ModelCapabilities
}

/** Adapts tool schemas between provider formats. */
export interface ToolSchemaAdapter {
  /** Convert our canonical tool schema to provider-specific format. */
  adapt(tool: Record<string, unknown>): Record<string, unknown>
  /** Whether this adapter needs conversion (no-op for Anthropic-compatible). */
  needsConversion: boolean
}

/** Resolved model — the concrete provider + model after routing. */
export interface ResolvedModel {
  providerId: ProviderID
  provider: LLMProvider
  modelId: ModelID
  spec: ModelSpec
  thinking?: ThinkingConfig
  toolAdapter?: ToolSchemaAdapter
}
