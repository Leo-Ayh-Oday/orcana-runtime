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
  type: "text" | "tool_call" | "tool_result" | "thinking_blocks" | "status" | "error" | "done" | "confirm" | "token_usage" | "plan_ready" | "task_progress" | "clarification_ready" | "user_question" | "truncated" | "finish"
  /** For confirm: { tool: string, params: Record<string,unknown>, message: string } */
  data?: unknown
}

/** IC03: 结构化 Provider 结束原因 —— 上层 control-flow 的唯一事实来源。
 *  Runtime 不得再从 error/status 字符串里猜 max_tokens/length/auth/quota。 */
export type ProviderFinishReason =
  | "complete"
  | "tool_action"
  | "truncated_before_action"
  | "truncated_after_action"
  | "truncated_partial_tool"
  | "transport_failure"
  | "auth_failure"
  | "quota_failure"
  | "cancelled"
  | "malformed"

/** IC03: retry 分类 kind → 结构化 finish（retry 耗尽 / 不可重试时使用）。
 *  kind 来自 provider/retry.ts classifyProviderError（非字符串猜测主路径）。
 *
 *  retryability semantics 保持原样（P0-2）：
 *    auth / quota              → non-retryable typed finish
 *    network/rate_limit/
 *    capacity/server           → transport_failure（retryable）
 *    client / unknown          → malformed（non-retryable —— 复用既有
 *      ProviderFinishReason，不新增第 11 个值） */
export function providerFinishReasonFromErrorKind(kind: string | undefined): ProviderFinishReason {
  if (kind === "auth") return "auth_failure"
  if (kind === "quota") return "quota_failure"
  if (kind === "network" || kind === "rate_limit" || kind === "capacity" || kind === "server") return "transport_failure"
  return "malformed"
}

/** IC03: 每个 production Provider round 结束时 exactly-once 的 finish 事件负载。 */
export interface ProviderFinishInfo {
  finishReason: ProviderFinishReason
  rawStopReason?: string
  completedToolCallCount: number
  partialToolCall: boolean
}

/** IC03: Provider 输出预算计划 —— 在请求形成前规划（thinking + action 共享
 *  同一输出 envelope）。Provider 只能执行已规划好的 request。 */
export interface ProviderOutputBudgetPlan {
  providerMaxOutputTokens: number
  thinkingBudgetTokens: number
  actionReserveTokens: number
  totalRequestedTokens: number
}

/**
 * GATE-02 (GS-03/GS-05): provider response envelope class.
 *
 * `max_tokens` is TRUNCATED, not an error: tool blocks that closed before the
 * cut are complete side effects and are emitted; a blind generic retry is
 * forbidden (that was the OTS-013 loop). Truncation continuation is a distinct
 * round, never a retry of the same request.
 */
export type ProviderStopClass =
  | "COMPLETED"
  | "TOOL_USE"
  | "TRUNCATED"
  | "RATE_LIMITED"
  | "TRANSPORT_FAILURE"
  | "AUTH_FAILURE"
  | "PROVIDER_FAILURE"

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
  /**
   * PR-GATE-06: Run 级统一重试预算。注入后 provider 的 transport/rateLimit
   * 重试由 RetryLedger 限次（与 capability/repair 等层共享同一预算，
   * 禁止各层独立无限重试）；未注入时回退构造时 maxRetries（legacy）。
   */
  retryLedger?: import("../runtime/retry-ledger").RetryLedger
  /**
   * IC04: Run 级 RetryCoordinator（retry decision authority）。注入后
   * provider 的每次 physical attempt（initial + retry）在请求发出前经
   * coordinator 授权（class budget + global physical request budget +
   * side-effect boundary）。未注入时回退 retryLedger / maxRetries（legacy
   * compatibility，§35）。MultiProvider spread 透传本字段。
   */
  retryCoordinator?: import("../runtime/retry/coordinator").RetryCoordinator
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
