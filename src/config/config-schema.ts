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
  models: Record<string, ModelConfig>
}

export interface ModelConfig {
  displayName?: string
  contextWindow?: number
  maxOutputTokens?: number
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

export const builtInProviders: Record<string, ProviderConfig> = {
  deepseek: {
    type: "deepseek",
    displayName: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    models: {
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
    default: "deepseek-chat",
    small: "deepseek-chat",
    planner: "deepseek-reasoner",
    coder: "deepseek-chat",
    reviewer: "deepseek-reasoner",
    judge: "deepseek-reasoner",
    summarizer: "deepseek-chat",
  },
  providers: builtInProviders,
}
