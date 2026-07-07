/** 配置加载器 — 读取、解析、合并 JSONC 配置文件。
 *
 *  优先级（低 → 高）：
 *    1. built-in defaults (defaultConfig from config-schema)
 *    2. global config (~/.deepseek-code/orcana.jsonc)
 *    3. project config (默认关闭；ORCANA_ENABLE_PROJECT_CONFIG=1 时启用)
 *    4. env override (TUI 默认关闭)
 *
 *  不处理 CLI flags — 那是 CLI 层的职责。
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import {
  defaultConfig,
  builtInProviders,
  type OrcanaConfig,
  type ProviderConfig,
  type RoleModelConfig,
} from "./config-schema"
import { globalConfigPath, projectConfigPath } from "./paths"

// ── JSONC 解析 ──

/** 去除 JSONC 注释（// 和块注释），返回可被 JSON.parse 的纯 JSON。 */
export function stripJsoncComments(text: string): string {
  let result = ""
  let i = 0
  let inString = false
  let stringChar = ""

  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]

    // 在字符串内：直接复制直到结束引号
    if (inString) {
      result += ch
      if (ch === "\\" && next !== undefined) {
        result += next
        i += 2
        continue
      }
      if (ch === stringChar) {
        inString = false
      }
      i++
      continue
    }

    // 不在字符串内
    if (ch === '"' || ch === "'") {
      inString = true
      stringChar = ch
      result += ch
      i++
      continue
    }

    // 行注释 //...
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++
      continue
    }

    // 块注释 /* ... */
    if (ch === "/" && next === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 2
      continue
    }

    result += ch
    i++
  }

  return result
}

/** 解析 JSONC 文本为对象，解析失败返回 null。 */
export function parseJsonc<T = unknown>(text: string): T | null {
  try {
    return JSON.parse(stripJsoncComments(text)) as T
  } catch {
    return null
  }
}

// ── 文件读取 ──

/** 读取并解析 JSONC 配置文件，不存在或解析失败返回 null。 */
function readConfigFile(filePath: string): OrcanaConfig | null {
  if (!existsSync(filePath)) return null
  try {
    const raw = readFileSync(filePath, "utf-8")
    return parseJsonc<OrcanaConfig>(raw)
  } catch {
    return null
  }
}

export function readGlobalConfig(filePath: string = globalConfigPath()): OrcanaConfig | null {
  return readConfigFile(filePath)
}

export function writeGlobalConfig(config: OrcanaConfig, filePath: string = globalConfigPath()): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8")
}

export function updateGlobalConfig(
  updater: (config: OrcanaConfig) => OrcanaConfig,
  filePath: string = globalConfigPath(),
): OrcanaConfig {
  const current = readGlobalConfig(filePath) ?? {}
  const next = updater(current)
  writeGlobalConfig(next, filePath)
  return next
}

// ── 配置合并 ──

/** 深合并两个对象（后者覆盖前者，数组和基本类型直接替换）。 */
export function deepMerge<T>(base: T, override: Partial<T> | undefined): T {
  if (override === undefined || override === null) return base
  if (typeof base !== "object" || typeof override !== "object") {
    return override as T
  }
  if (Array.isArray(base) || Array.isArray(override)) {
    return override as T
  }
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    if (value !== undefined) {
      result[key] = deepMerge(result[key], value as Partial<unknown>)
    }
  }
  return result as T
}

/** 合并 providers：用户自定义 provider 覆盖内置，用户可添加新 provider。 */
function mergeProviders(
  base: Record<string, ProviderConfig>,
  override: Record<string, ProviderConfig> | undefined,
): Record<string, ProviderConfig> {
  if (!override) return base
  const result: Record<string, ProviderConfig> = { ...base }
  for (const [id, userConfig] of Object.entries(override)) {
    const builtin = result[id]
    if (builtin) {
      // 深合并：用户的 baseUrl、displayName 等覆盖内置，models 合并
      result[id] = deepMerge(builtin, userConfig)
    } else {
      // 新 provider，直接加入
      result[id] = userConfig
    }
  }
  return result
}

// ── 环境变量覆盖 ──

/** 从环境变量读取 provider API key 的覆盖。
 *  注意：实际的 key 存储在 AuthStore 中，这里只处理 env 变量名映射。 */
function applyEnvOverrides(config: OrcanaConfig): OrcanaConfig {
  const result = { ...config }

  // DEEPSEEK_MODEL_OVERRIDE 覆盖 default model
  const modelOverride = process.env.DEEPSEEK_MODEL_OVERRIDE
  if (modelOverride) {
    result.models = { ...result.models, default: modelOverride }
  }

  // DEEPSEEK_MAX_ROUNDS 覆盖 maxRounds
  const maxRounds = process.env.DEEPSEEK_MAX_ROUNDS
  if (maxRounds) {
    const n = Number(maxRounds)
    if (Number.isFinite(n) && n > 0) {
      result.runtime = { ...result.runtime, maxRounds: n }
    }
  }

  return result
}

// ── 主加载函数 ──

export interface LoadConfigOptions {
  /** 项目根目录（默认 process.cwd()）。 */
  cwd?: string
  /** 全局配置路径（默认 globalConfigPath()）。 */
  globalPath?: string
  /** 是否应用环境变量覆盖（默认 true）。 */
  applyEnv?: boolean
  /** 是否读取项目级 ./orcana.jsonc。默认 false；ORCANA_ENABLE_PROJECT_CONFIG=1 时启用。 */
  loadProject?: boolean
}

/** 加载并合并配置。
 *
 *  优先级：defaultConfig → global → project(可选) → env(可选)
 */
export function loadConfig(options: LoadConfigOptions = {}): OrcanaConfig {
  const {
    cwd,
    globalPath = globalConfigPath(),
    applyEnv = true,
    loadProject = process.env.ORCANA_ENABLE_PROJECT_CONFIG === "1",
  } = options

  // 1. 从默认配置开始
  let config: OrcanaConfig = { ...defaultConfig }

  // 2. 合并全局配置
  const globalConfig = readConfigFile(globalPath)
  if (globalConfig) {
    config = deepMerge(config, globalConfig)
    // providers 需要特殊合并（保留内置 + 用户覆盖）
    if (globalConfig.providers) {
      config.providers = mergeProviders(builtInProviders, globalConfig.providers)
    }
  }

  // 3. 合并项目配置（默认关闭，Orcana 当前使用 global-only 配置中心）
  if (loadProject) {
    const projectPath = projectConfigPath(cwd)
    const projConfig = readConfigFile(projectPath)
    if (projConfig) {
      config = deepMerge(config, projConfig)
      if (projConfig.providers) {
        config.providers = mergeProviders(config.providers ?? builtInProviders, projConfig.providers)
      }
    }
  }

  // 4. 环境变量覆盖
  if (applyEnv) {
    config = applyEnvOverrides(config)
  }

  return config
}

// ── 辅助查询函数 ──

/** 获取所有已知 provider 的 ID 列表。 */
export function listProviderIds(config: OrcanaConfig): string[] {
  return Object.keys(config.providers ?? {})
}

/** 获取指定 provider 的配置。 */
export function getProviderConfig(config: OrcanaConfig, providerId: string): ProviderConfig | undefined {
  return config.providers?.[providerId]
}

/** 获取指定 provider 的所有模型 ID。 */
export function listModelIds(config: OrcanaConfig, providerId: string): string[] {
  return Object.keys(config.providers?.[providerId]?.models ?? {})
}

/** 解析角色到具体模型，fallback：role → default → deepseek-v4-pro。 */
export function resolveModelForRole(
  role: keyof RoleModelConfig,
  config: OrcanaConfig,
): string {
  const roleModel = config.models?.[role]
  if (roleModel) return roleModel
  const defaultModel = config.models?.default
  if (defaultModel) return defaultModel
  return "deepseek-v4-pro"
}

/** 查找模型所属的 provider ID。 */
export function findProviderForModel(config: OrcanaConfig, modelId: string): string | undefined {
  for (const [providerId, providerConfig] of Object.entries(config.providers ?? {})) {
    if (providerConfig.models[modelId]) {
      return providerId
    }
  }
  return undefined
}

/** 生成配置的安全摘要（不包含 API key）。 */
export function configSummary(config: OrcanaConfig): string {
  const providers = Object.entries(config.providers ?? {}).map(([id, p]) => {
    const modelCount = Object.keys(p.models).length
    return `${id}(${p.type}, ${modelCount} models)`
  })
  const roles = Object.entries(config.models ?? {})
    .map(([role, model]) => `${role}=${model}`)
    .join(", ")
  return `default=${config.defaultProvider ?? "?"} | providers: ${providers.join(", ")} | roles: ${roles}`
}
