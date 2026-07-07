/** Provider 配置 Schema — 配置文件中的类型定义。
 *
 *  注意：这里用的是配置文件格式（ProviderCapabilities with supports* 字段），
 *  与 src/provider/types.ts 中的 ModelCapabilities 不同。
 *  capabilities.ts 负责两者之间的映射。
 */

// ── 配置文件根类型 ──

export interface OrcanaConfig {
  $schema?: string

  /** 默认 provider ID（如 "deepseek"）。 */
  defaultProvider?: string

  /** 角色 → 模型 路由配置。 */
  models?: RoleModelConfig

  /** provider 定义（用户可自定义 baseUrl、模型列表等）。 */
  providers?: Record<string, ProviderConfig>

  /** runtime 行为配置。 */
  runtime?: {
    permissionMode?: "ask" | "auto-readonly" | "strict"
    maxRounds?: number
    contextBudget?: number
    thinkingEffort?: "auto" | "low" | "medium" | "high" | "max"
    /** 默认 false：Orcana 的 key/config 与用户系统环境变量隔离。 */
    allowEnvKeys?: boolean
  }
}

// ── 角色 → 模型 路由 ──

export interface RoleModelConfig {
  default?: string
  small?: string
  planner?: string
  coder?: string
  reviewer?: string
  judge?: string
  summarizer?: string
  fim?: string
}

export type RoleKey = keyof RoleModelConfig

// ── Provider 配置 ──

export type ProviderType =
  | "deepseek"
  | "anthropic"
  | "openai"
  | "openai-compatible"
  | "ollama"
  | "lmstudio"
  | "openrouter"

export interface ProviderConfig {
  type: ProviderType
  displayName?: string
  baseUrl?: string
  /** API key 环境变量名（运行时从 env 读取，不写入配置文件）。 */
  apiKeyEnv?: string
  /** 指向 auth.json 中的 credential profile，如 "deepseek/default"。 */
  credentialRef?: string
  models: Record<string, ModelConfig>
}

export interface ModelConfig {
  displayName?: string
  contextWindow?: number
  maxOutputTokens?: number
  pricingTier?: "free" | "cheap" | "standard" | "premium"
  tags?: string[]
  capabilities?: Partial<ProviderCapabilities>
}

// ── 能力声明（配置文件格式） ──

export interface ProviderCapabilities {
  supportsToolCalls: boolean
  supportsStreaming: boolean
  supportsJsonMode: boolean
  supportsThinking: boolean
  supportsReasoningEffort: boolean
  supportsFim: boolean
  supportsPrefixCache: boolean
  supportsVision: boolean
  supportsEmbeddings: boolean
  maxContextTokens: number
  maxOutputTokens?: number
}

// ── 内置 Provider 默认配置 ──

const OPENAI_COMPAT_CODING_CAPS: Partial<ProviderCapabilities> = {
  supportsToolCalls: true,
  supportsStreaming: true,
  supportsJsonMode: true,
  supportsThinking: true,
  supportsReasoningEffort: true,
  supportsFim: false,
  supportsPrefixCache: false,
  supportsVision: false,
  supportsEmbeddings: false,
  maxContextTokens: 128_000,
  maxOutputTokens: 16_384,
}

const OPENAI_COMPAT_FAST_CAPS: Partial<ProviderCapabilities> = {
  ...OPENAI_COMPAT_CODING_CAPS,
  supportsThinking: false,
  supportsReasoningEffort: false,
  maxOutputTokens: 8_192,
}

const OPENAI_COMPAT_VISION_AGENT_CAPS: Partial<ProviderCapabilities> = {
  ...OPENAI_COMPAT_CODING_CAPS,
  supportsVision: true,
  maxContextTokens: 256_000,
  maxOutputTokens: 32_768,
}

export const builtInProviders: Record<string, ProviderConfig> = {
  deepseek: {
    type: "deepseek",
    displayName: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    models: {
      "deepseek-v4-pro": {
        displayName: "DeepSeek V4 Pro",
        contextWindow: 1_048_576,
        maxOutputTokens: 393_216,
        pricingTier: "standard",
        tags: ["coding", "reasoning", "deep-thinking", "agent"],
        capabilities: {
          supportsToolCalls: true,
          supportsStreaming: true,
          supportsJsonMode: true,
          supportsThinking: true,
          supportsReasoningEffort: true,
          supportsFim: true,
          supportsPrefixCache: true,
          supportsVision: false,
          supportsEmbeddings: false,
          maxContextTokens: 1_048_576,
          maxOutputTokens: 393_216,
        },
      },
      "deepseek-v4-flash": {
        displayName: "DeepSeek V4 Flash",
        contextWindow: 1_048_576,
        maxOutputTokens: 393_216,
        pricingTier: "cheap",
        tags: ["fast", "coding", "reasoning", "agent"],
        capabilities: {
          supportsToolCalls: true,
          supportsStreaming: true,
          supportsJsonMode: true,
          supportsThinking: true,
          supportsReasoningEffort: true,
          supportsFim: true,
          supportsPrefixCache: true,
          supportsVision: false,
          supportsEmbeddings: false,
          maxContextTokens: 1_048_576,
          maxOutputTokens: 393_216,
        },
      },
      "deepseek-chat": {
        displayName: "DeepSeek Chat",
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
        capabilities: {
          supportsToolCalls: true,
          supportsStreaming: true,
          supportsJsonMode: true,
          supportsThinking: false,
          supportsReasoningEffort: false,
          supportsFim: false,
          supportsPrefixCache: true,
          supportsVision: false,
          supportsEmbeddings: false,
          maxContextTokens: 128_000,
          maxOutputTokens: 8_192,
        },
      },
      "deepseek-reasoner": {
        displayName: "DeepSeek Reasoner (R1)",
        contextWindow: 128_000,
        maxOutputTokens: 32_768,
        capabilities: {
          supportsToolCalls: false,
          supportsStreaming: true,
          supportsJsonMode: false,
          supportsThinking: true,
          supportsReasoningEffort: false,
          supportsFim: false,
          supportsPrefixCache: true,
          supportsVision: false,
          supportsEmbeddings: false,
          maxContextTokens: 128_000,
          maxOutputTokens: 32_768,
        },
      },
    },
  },
  qwen: {
    type: "openai-compatible",
    displayName: "Qwen / DashScope",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    models: {
      "qwen3.7-max": {
        displayName: "Qwen3.7 Max",
        contextWindow: 1_000_000,
        maxOutputTokens: 65_536,
        pricingTier: "premium",
        tags: ["coding", "agent", "reasoning", "long-context"],
        capabilities: { ...OPENAI_COMPAT_CODING_CAPS, maxContextTokens: 1_000_000, maxOutputTokens: 65_536 },
      },
      "qwen3.7-plus": {
        displayName: "Qwen3.7 Plus",
        contextWindow: 1_000_000,
        maxOutputTokens: 65_536,
        pricingTier: "standard",
        tags: ["coding", "agent", "reasoning", "vision"],
        capabilities: { ...OPENAI_COMPAT_VISION_AGENT_CAPS, maxContextTokens: 1_000_000, maxOutputTokens: 65_536 },
      },
      "qwen3.6-flash": {
        displayName: "Qwen3.6 Flash",
        contextWindow: 1_000_000,
        maxOutputTokens: 32_768,
        pricingTier: "cheap",
        tags: ["fast", "coding", "agent"],
        capabilities: { ...OPENAI_COMPAT_FAST_CAPS, maxContextTokens: 1_000_000, maxOutputTokens: 32_768 },
      },
      "qwen3-coder-plus": {
        displayName: "Qwen3 Coder Plus",
        contextWindow: 1_000_000,
        maxOutputTokens: 32_768,
        pricingTier: "standard",
        tags: ["coding", "agent", "reasoning"],
        capabilities: { ...OPENAI_COMPAT_CODING_CAPS, maxContextTokens: 1_000_000, maxOutputTokens: 32_768 },
      },
      "qwen3-coder-flash": {
        displayName: "Qwen3 Coder Flash",
        contextWindow: 1_000_000,
        maxOutputTokens: 8_192,
        pricingTier: "cheap",
        tags: ["fast", "coding", "agent"],
        capabilities: { ...OPENAI_COMPAT_FAST_CAPS, maxContextTokens: 1_000_000 },
      },
    },
  },
  kimi: {
    type: "openai-compatible",
    displayName: "Kimi / Moonshot",
    baseUrl: "https://api.moonshot.ai/v1",
    apiKeyEnv: "MOONSHOT_API_KEY",
    models: {
      "kimi-k2.7-code": {
        displayName: "Kimi K2.7 Code",
        contextWindow: 262_144,
        maxOutputTokens: 32_768,
        pricingTier: "standard",
        tags: ["coding", "agent", "reasoning", "vision"],
        capabilities: { ...OPENAI_COMPAT_VISION_AGENT_CAPS, maxContextTokens: 262_144, maxOutputTokens: 32_768 },
      },
      "kimi-k2.7-code-highspeed": {
        displayName: "Kimi K2.7 Code HighSpeed",
        contextWindow: 262_144,
        maxOutputTokens: 32_768,
        pricingTier: "premium",
        tags: ["fast", "coding", "agent", "reasoning", "vision"],
        capabilities: { ...OPENAI_COMPAT_VISION_AGENT_CAPS, maxContextTokens: 262_144, maxOutputTokens: 32_768 },
      },
      "kimi-k2.6": {
        displayName: "Kimi K2.6",
        contextWindow: 262_144,
        maxOutputTokens: 32_768,
        pricingTier: "standard",
        tags: ["agent", "reasoning", "vision"],
        capabilities: { ...OPENAI_COMPAT_VISION_AGENT_CAPS, maxContextTokens: 262_144, maxOutputTokens: 32_768 },
      },
    },
  },
  zhipu: {
    type: "openai-compatible",
    displayName: "Zhipu GLM",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    apiKeyEnv: "ZHIPUAI_API_KEY",
    models: {
      "glm-5.2": {
        displayName: "GLM 5.2",
        contextWindow: 1_048_576,
        maxOutputTokens: 131_072,
        pricingTier: "premium",
        tags: ["coding", "agent", "reasoning", "long-context"],
        capabilities: { ...OPENAI_COMPAT_CODING_CAPS, supportsPrefixCache: true, maxContextTokens: 1_048_576, maxOutputTokens: 131_072 },
      },
      "glm-5.1": {
        displayName: "GLM 5.1",
        contextWindow: 128_000,
        maxOutputTokens: 131_072,
        pricingTier: "standard",
        tags: ["coding", "agent", "reasoning"],
        capabilities: { ...OPENAI_COMPAT_CODING_CAPS, supportsPrefixCache: true, maxOutputTokens: 131_072 },
      },
      "glm-5": {
        displayName: "GLM 5",
        contextWindow: 128_000,
        maxOutputTokens: 131_072,
        pricingTier: "standard",
        tags: ["coding", "agent", "reasoning"],
        capabilities: { ...OPENAI_COMPAT_CODING_CAPS, supportsPrefixCache: true, maxOutputTokens: 131_072 },
      },
      "glm-5-turbo": {
        displayName: "GLM 5 Turbo",
        contextWindow: 128_000,
        maxOutputTokens: 131_072,
        pricingTier: "cheap",
        tags: ["fast", "coding", "agent", "reasoning"],
        capabilities: { ...OPENAI_COMPAT_CODING_CAPS, supportsPrefixCache: true, maxOutputTokens: 131_072 },
      },
    },
  },
  siliconflow: {
    type: "openai-compatible",
    displayName: "SiliconFlow",
    baseUrl: "https://api.siliconflow.com/v1",
    apiKeyEnv: "SILICONFLOW_API_KEY",
    models: {
      "deepseek-ai/DeepSeek-R1": {
        displayName: "DeepSeek R1 on SiliconFlow",
        contextWindow: 128_000,
        maxOutputTokens: 16_384,
        pricingTier: "standard",
        tags: ["reasoning", "agent"],
        capabilities: OPENAI_COMPAT_CODING_CAPS,
      },
      "Qwen/Qwen3-Coder": {
        displayName: "Qwen3 Coder on SiliconFlow",
        contextWindow: 128_000,
        maxOutputTokens: 16_384,
        pricingTier: "standard",
        tags: ["coding", "agent"],
        capabilities: OPENAI_COMPAT_CODING_CAPS,
      },
    },
  },
  minimax: {
    type: "openai-compatible",
    displayName: "MiniMax",
    baseUrl: "https://api.minimax.io/v1",
    apiKeyEnv: "MINIMAX_API_KEY",
    models: {
      "MiniMax-M3": {
        displayName: "MiniMax M3",
        contextWindow: 1_000_000,
        maxOutputTokens: 512_000,
        pricingTier: "premium",
        tags: ["coding", "agent", "multimodal", "long-context"],
        capabilities: { ...OPENAI_COMPAT_VISION_AGENT_CAPS, maxContextTokens: 1_000_000, maxOutputTokens: 512_000 },
      },
      "MiniMax-M2.7": {
        displayName: "MiniMax M2.7",
        contextWindow: 204_800,
        maxOutputTokens: 32_768,
        pricingTier: "standard",
        tags: ["coding", "agent", "reasoning"],
        capabilities: { ...OPENAI_COMPAT_CODING_CAPS, maxContextTokens: 204_800, maxOutputTokens: 32_768 },
      },
      "MiniMax-M2.7-highspeed": {
        displayName: "MiniMax M2.7 HighSpeed",
        contextWindow: 204_800,
        maxOutputTokens: 32_768,
        pricingTier: "premium",
        tags: ["fast", "coding", "agent", "reasoning"],
        capabilities: { ...OPENAI_COMPAT_CODING_CAPS, maxContextTokens: 204_800, maxOutputTokens: 32_768 },
      },
    },
  },
  stepfun: {
    type: "openai-compatible",
    displayName: "StepFun",
    baseUrl: "https://api.stepfun.ai/step_plan/v1",
    apiKeyEnv: "STEPFUN_API_KEY",
    models: {
      "step-3.7-flash": {
        displayName: "Step 3.7 Flash",
        contextWindow: 262_144,
        maxOutputTokens: 32_768,
        pricingTier: "cheap",
        tags: ["fast", "coding", "agent", "reasoning", "vision"],
        capabilities: { ...OPENAI_COMPAT_VISION_AGENT_CAPS, maxContextTokens: 262_144, maxOutputTokens: 32_768 },
      },
    },
  },
  custom: {
    type: "openai-compatible",
    displayName: "Custom OpenAI-compatible",
    apiKeyEnv: "ORCANA_CUSTOM_API_KEY",
    models: {},
  },
  openrouter: {
    type: "openrouter",
    displayName: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    models: {},
  },
  ollama: {
    type: "ollama",
    displayName: "Ollama (local)",
    baseUrl: "http://localhost:11434",
    models: {},
  },
  lmstudio: {
    type: "lmstudio",
    displayName: "LM Studio (local)",
    baseUrl: "http://localhost:1234/v1",
    models: {},
  },
}

/** 默认配置（DeepSeek-first）。 */
export const defaultConfig: OrcanaConfig = {
  defaultProvider: "deepseek",
  models: {
    default: "deepseek-v4-pro",
    small: "deepseek-v4-flash",
    planner: "deepseek-v4-pro",
    coder: "deepseek-v4-pro",
    reviewer: "deepseek-v4-pro",
    judge: "deepseek-v4-pro",
    summarizer: "deepseek-v4-flash",
  },
  providers: builtInProviders,
  runtime: {
    allowEnvKeys: false,
  },
}
