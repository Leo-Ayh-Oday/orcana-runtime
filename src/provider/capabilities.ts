/** 能力映射 — 配置文件格式 (ProviderCapabilities) → 运行时格式 (ModelCapabilities)。
 *
 *  配置文件用 supports* 布尔字段（用户友好），
 *  运行时用 ModelCapabilities（与现有 ProviderRegistry/ModelRouter 集成）。
 */

import type { ProviderCapabilities, ModelConfig, ProviderConfig } from "../config/config-schema"
import type {
  ModelCapabilities,
  ModelSpec,
  ThinkingCapability,
  PricingTier,
} from "./types"

/** 将配置文件的 ProviderCapabilities 映射为运行时 ModelCapabilities。 */
export function toModelCapabilities(caps: Partial<ProviderCapabilities> | undefined): ModelCapabilities {
  return {
    toolUse: caps?.supportsToolCalls ?? false,
    streaming: caps?.supportsStreaming ?? true,
    structuredOutput: caps?.supportsJsonMode ?? false,
    thinking: caps?.supportsThinking ?? false,
    fim: caps?.supportsFim ?? false,
    contextCaching: caps?.supportsPrefixCache ?? false,
    vision: caps?.supportsVision ?? false,
    maxContextWindow: caps?.maxContextTokens ?? 128_000,
  }
}

/** 从 ModelConfig 构建 ThinkingCapability。 */
export function toThinkingCapability(caps: Partial<ProviderCapabilities> | undefined): ThinkingCapability {
  const supportsThinking = caps?.supportsThinking ?? false
  const supportsEffort = caps?.supportsReasoningEffort ?? false
  return {
    supported: supportsThinking,
    effortLevels: supportsEffort ? ["high", "max"] : supportsThinking ? ["high"] : [],
  }
}

/** 从 ModelConfig + providerId 构建完整的 ModelSpec。 */
export function toModelSpec(
  modelId: string,
  providerId: string,
  modelConfig: ModelConfig,
  providerConfig: ProviderConfig,
): ModelSpec {
  const caps = modelConfig.capabilities
  const pricingTier = modelConfig.pricingTier ?? inferPricingTier(providerConfig.type)
  return {
    id: modelId,
    providerId,
    displayName: modelConfig.displayName ?? modelId,
    contextWindow: modelConfig.contextWindow ?? caps?.maxContextTokens ?? 128_000,
    maxOutputTokens: modelConfig.maxOutputTokens ?? caps?.maxOutputTokens ?? 8_192,
    pricingTier,
    thinking: toThinkingCapability(caps),
    capabilities: toModelCapabilities(caps),
    tags: modelConfig.tags ?? inferTags(caps),
    isDefault: false,
  }
}

/** 根据 provider type 推断定价层级。 */
function inferPricingTier(providerType: ProviderConfig["type"]): PricingTier {
  switch (providerType) {
    case "ollama":
    case "lmstudio":
      return "free"
    case "deepseek":
      return "cheap"
    case "openrouter":
      return "standard"
    case "anthropic":
    case "openai":
    case "openai-compatible":
      return "standard"
    default:
      return "standard"
  }
}

/** 从能力推断标签（用于 purpose-based routing）。 */
function inferTags(caps: Partial<ProviderCapabilities> | undefined): string[] {
  const tags: string[] = []
  if (caps?.supportsThinking) tags.push("thinking", "reasoning")
  if (caps?.supportsFim) tags.push("fim", "coding")
  if (caps?.supportsToolCalls) tags.push("tools", "agent")
  if (caps?.supportsVision) tags.push("vision")
  if (caps?.supportsJsonMode) tags.push("json", "structured")
  if (caps?.supportsPrefixCache) tags.push("cache")
  if (tags.length === 0) tags.push("general")
  return tags
}

/** 检查模型是否满足角色要求，返回不满足的能力列表（空数组 = 全部满足）。 */
export function checkRoleCapability(
  caps: ModelCapabilities,
  role: string,
): string[] {
  const missing: string[] = []
  switch (role) {
    case "coder":
    case "fim":
      if (!caps.fim) missing.push("fim")
      break
    case "planner":
    case "reviewer":
    case "judge":
      if (!caps.thinking) missing.push("thinking")
      break
    case "default":
    case "small":
    case "summarizer":
      // 基础角色，无特殊要求
      break
  }
  // 所有 agent 角色都需要 tool calls
  if (role === "coder" || role === "default") {
    if (!caps.toolUse) missing.push("toolUse")
  }
  return missing
}
