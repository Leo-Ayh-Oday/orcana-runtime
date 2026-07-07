/** Shared runtime bootstrap — single assembly point for CLI and TUI.
 *
 *  Every consumer (CLI, TUI, future entry points) calls createRuntime() once
 *  and receives a consistent set of initialized services. No more per-UI drift.
 *
 *  Design invariants:
 *    - Provider registry, ModelRouter, tools, hooks, session, memory, LSP, MCP
 *      are all initialized HERE, not in individual UIs
 *    - UIs only consume the runtime — they never re-assemble it
 *    - Version is always read from package.json at runtime (single source of truth)
 */

import { DeepSeekProvider } from "../provider/deepseek"
import { AnthropicProvider } from "../provider/anthropic"
import { OpenAIProvider } from "../provider/openai"
import { MultiProvider, openaiToolAdapter } from "../provider/multi"
import { ProviderRegistry } from "../provider/registry"
import { ModelRouter } from "../provider/router"
import { toModelSpec } from "../provider/capabilities"
import { getProviderConfig, loadConfig, resolveModelForRole, updateGlobalConfig, type LoadConfigOptions } from "../config/config-loader"
import type { ModelConfig, OrcanaConfig, ProviderConfig } from "../config/config-schema"
import { getDefaultAuthStore, type AuthStore } from "../config/auth-store"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../provider/types"
import { buildTools, type ToolDef, type ToolDescriptor } from "../tools/registry"
import { FILE_TOOLS } from "../tools/file"
import { SHELL_TOOL } from "../tools/shell"
import { START_SERVICE_TOOL } from "../tools/service"
import { GIT_TOOLS } from "../tools/git"
import { WEB_SEARCH } from "../tools/search"
import { WEB_FETCH_TOOL } from "../tools/webfetch"
import { CODEGRAPH_TOOLS } from "../tools/codegraph"
import { LSP_TOOLS } from "../tools/lsp"
import { TYPECHECK_TOOL } from "../tools/typescript"
import { HookSystem } from "../hooks"
import { writeGuardBefore, writeGuardAfter, createJournalGuard } from "../hooks/builtin"
import { createSafetyPolicyHook } from "../hooks/safety-policy"
import { StagedContextManager } from "../context/staged"
import { SessionManager, SessionStore, needsMigration, migrateAllJsonSessions } from "../session"
import { registerCheckpointStore, unregisterCheckpointStore } from "../session/checkpoint"
import { ThinkingStore } from "../memory/thinking-store"
import { KnowledgeBase } from "../memory/knowledge"
import {
  addTurn,
  buildDynamicMemoryContext,
  buildStableAnchorContext,
  createBaseCheckpoint,
  createCompactor,
  restoreCompactorState,
  saveCompactorState,
} from "../memory/compactor"
import type { CompactionState } from "../memory/compactor"
import { AgentRunTrace } from "../agent/run-trace"
import { getLSPClient } from "../lsp/client"
import { bootstrapMCP, type MCPBridgeResult } from "../mcp/bridge"
import type { AgentOptions } from "../agent/loop-types"
import { VERSION } from "../version"

// ── Meta-tools (task, deeper_thinking) — defined here so both CLI and TUI share them ──
import { addNode, removeNode, skipNode, planRef, planProgress } from "../agent/master-plan"

const REQUEST_DEEPER_THINKING: ToolDef = {
  name: "request_deeper_thinking",
  description:
    "当你发现当前推理不足以解决此问题、需要更大的思考预算时调用。" +
    "如果问题涉及架构决策、安全审查、跨文件影响、多层抽象或需要穷举边界条件，说明理由。" +
    "触发后下一轮将升级到 think-max 32K tokens。",
  isReadonly: true,
  isConcurrencySafe: true,
  userFacingName: "更深思考",
  inputSchema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "为什么需要更深推理（架构/安全/跨文件/多抽象层/边界穷举）" },
    },
    required: ["reason"],
  },
  execute: async (_params: Record<string, unknown>) => {
    return { success: true, content: "下一轮将使用 thinking max 32K tokens 深度推理。", metadata: { upgradeThinking: "max" } }
  },
}

const TASK_TOOL: ToolDef = {
  name: "task",
  description:
    "管理主计划的任务树。当一个长任务被分解为多个阶段时，用它追踪进度。\n" +
    "\n" +
    "## 什么时候用它\n" +
    "- 任务涉及 3+ 个独立交付阶段（如「后端→前端→测试」）\n" +
    "- 执行中发现新的必须完成的子任务，但不在当前计划里\n" +
    "- 某个阶段发现没必要做了，需要从计划中移除\n" +
    "- 完成一个阶段后，想查看整体进度决定下一步\n" +
    "\n" +
    "## 操作\n" +
    "- list: 查看所有节点和状态\n" +
    "- add: 新增节点。参数 title（标题）, depends_on（依赖哪个节点 ID，可选）\n" +
    "- done: 标记完成。参数 node_id, reason（完成了什么，可选）\n" +
    "- remove: 删除不需要的节点。参数 node_id, reason（为什么不需要）\n" +
    "- skip: 跳过不做的节点。参数 node_id, reason",
  isReadonly: false,
  isConcurrencySafe: false,
  userFacingName: "任务管理",
  inputSchema: {
    type: "object",
    properties: {
      operation: { type: "string", description: "list | add | done | remove | skip" },
      title: { type: "string", description: "add 时的节点标题" },
      node_id: { type: "string", description: "done/remove/skip 时的节点 ID" },
      depends_on: { type: "string", description: "add 时的依赖节点 ID（逗号分隔，可选）" },
      reason: { type: "string", description: "done/remove/skip 时的原因或证据" },
    },
    required: ["operation"],
  },
  execute: async (params: Record<string, unknown>) => {
    const plan = planRef.current
    if (!plan) return { success: false, content: "没有活跃的主计划。长任务启动后主计划会自动创建。", error: "no active plan" }

    const op = String(params.operation ?? "")
    switch (op) {
      case "list": {
        const nodes = plan.nodes.map(n => {
          const icon = { pending: "🔵", active: "🔄", blocked: "🟡", done: "✅", skipped: "❌" }[n.status]
          return `${icon} ${n.id}. ${n.title}${n.dependsOn.length ? ` (依赖: ${n.dependsOn.join(", ")})` : ""}${n.evidence ? ` — ${n.evidence}` : ""}`
        })
        return { success: true, content: `主计划: ${planProgress(plan)}\n\n${nodes.join("\n")}` }
      }
      case "add": {
        const title = String(params.title ?? "").trim()
        if (!title) return { success: false, content: "add 需要 title 参数", error: "missing title" }
        const deps = String(params.depends_on ?? "").split(",").map(s => s.trim()).filter(Boolean)
        const node = addNode(plan, title, deps)
        return { success: true, content: `已添加节点 ${node.id}. ${title}${deps.length ? ` (依赖: ${deps.join(", ")})` : ""}` }
      }
      case "done": {
        const id = String(params.node_id ?? "")
        if (!id) return { success: false, content: "done 需要 node_id 参数", error: "missing node_id" }
        const node = plan.nodes.find(n => n.id === id)
        if (!node) return { success: false, content: `节点 ${id} 不存在`, error: "not found" }
        node.status = "done"
        node.evidence = String(params.reason ?? "")
        plan.updatedAt = Date.now()
        return { success: true, content: `节点 ${id}. ${node.title} 已标记完成。${node.evidence ? `证据: ${node.evidence}` : ""}` }
      }
      case "remove": {
        const id = String(params.node_id ?? "")
        const reason = String(params.reason ?? "")
        const ok = removeNode(plan, id, reason)
        return ok
          ? { success: true, content: `节点 ${id} 已删除。${reason ? `原因: ${reason}` : ""}` }
          : { success: false, content: `无法删除节点 ${id}（不存在或已完成）`, error: "cannot remove" }
      }
      case "skip": {
        const id = String(params.node_id ?? "")
        const reason = String(params.reason ?? "")
        const ok = skipNode(plan, id, reason)
        return ok
          ? { success: true, content: `节点 ${id} 已跳过。${reason ? `原因: ${reason}` : ""}` }
          : { success: false, content: `无法跳过节点 ${id}（不存在或已完成）`, error: "cannot skip" }
      }
      default:
        return { success: false, content: `未知操作: ${op}。支持: list | add | done | remove | skip`, error: "unknown operation" }
    }
  },
}

// ── Runtime options ──

export interface RuntimeBootstrapOptions {
  /** Project root directory. Defaults to process.cwd(). */
  projectRoot?: string
  /** API keys. If not provided, read from auth store or process.env. */
  dsApiKey?: string
  anthApiKey?: string
  openaiApiKey?: string
  /** Model override from env/config. */
  modelOverride?: string
  /** Whether to bootstrap MCP servers. Default: true. */
  enableMCP?: boolean
  /** MCP status callback. */
  mcpOnStatus?: (msg: string) => void
  /** Whether to start LSP client. Default: true. */
  enableLSP?: boolean
  /** Gate telemetry file path. */
  gateTelemetryFile?: string
  /** ContextMap acquisition policy. */
  contextMapPolicy?: "off" | "auto" | "always"
  /** PR-6: Config loader options (cwd, globalPath, applyEnv). */
  configOptions?: LoadConfigOptions
  /** PR-6: AuthStore instance (defaults to FileAuthStore). */
  authStore?: AuthStore
  /** TUI setup mode: start even when the selected provider has no key yet. */
  allowMissingProviderAuth?: boolean
  /** Read API keys from user/system env vars. Default follows config.runtime.allowEnvKeys, which defaults false. */
  useEnvAuth?: boolean
}

export interface Runtime {
  // Provider
  provider: MultiProvider
  modelRouter: ModelRouter
  registry: ProviderRegistry
  modelOverride: string
  /** PR-6: 加载的 OrcanaConfig，供 TUI /connect /models 使用 */
  config: OrcanaConfig
  /** PR-6: AuthStore 实例，供 TUI /connect 保存 API key */
  authStore: AuthStore
  /** Whether a provider currently has a real API key registered. */
  isProviderConfigured: (providerId: string) => boolean
  /** Save optional key, activate provider, and switch the session model immediately. */
  configureModel: (input: { providerId: string; modelId: string; apiKey?: string; custom?: boolean; displayName?: string; baseUrl?: string }) => Promise<void>
  /** Persist thinking effort in the global Orcana config. */
  configureThinkingEffort: (effort: "auto" | "high" | "max") => void

  // Tools
  mcpResult: MCPBridgeResult
  mcpToolDefs: ToolDef[]
  allToolDefs: ToolDef[]
  tools: ToolDescriptor[]

  // Hooks
  hooks: HookSystem

  // Context
  stagedCtx: StagedContextManager

  // Session
  sessions: SessionManager
  sessionId: string

  // Memory
  thinkingStore: ThinkingStore
  knowledgeBase: KnowledgeBase
  compactor: CompactionState

  // LSP
  lspClient: ReturnType<typeof getLSPClient>

  // Version
  version: string

  // Factories
  /** Start a new run trace for the given user prompt. */
  startRunTrace: (prompt: string) => AgentRunTrace

  /** Build AgentOptions suitable for agentLoop(), with runtime defaults applied. */
  buildAgentOptions: (overrides?: Partial<AgentOptions>) => AgentOptions

  /** Register the session's checkpoint store (called when sessionId is known). */
  registerSessionCheckpointStore: (sid: string) => SessionStore

  /** Switch active session (unregisters old checkpoint store, registers new one). */
  switchSession: (newId: string) => void

  /** Clean up resources (LSP, etc.). Call on exit. */
  dispose: () => void
}

class MissingAuthProvider implements LLMProvider {
  constructor(private readonly providerId: string) {}

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    yield {
      type: "error",
      data: `还没有配置 ${this.providerId} 的 API key。请运行 /models，选择模型后输入 key。`,
    }
  }
}

function providerEnvKey(providerId: string, config: ProviderConfig | undefined): string | undefined {
  return config?.apiKeyEnv ?? {
    deepseek: "DEEPSEEK_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
  }[providerId]
}

function createProviderInstance(providerId: string, providerConfig: ProviderConfig | undefined, apiKey: string): LLMProvider {
  const type = providerConfig?.type ?? providerId
  const baseUrl = providerConfig?.baseUrl
  if (type === "deepseek") return new DeepSeekProvider(apiKey, baseUrl ?? "https://api.deepseek.com/anthropic")
  if (type === "anthropic") return new AnthropicProvider(apiKey, baseUrl ? { baseURL: baseUrl } : {})
  return new OpenAIProvider(apiKey, { baseURL: baseUrl })
}

function providerToolAdapter(providerConfig: ProviderConfig | undefined) {
  const type = providerConfig?.type
  return type === "openai" || type === "openai-compatible" || type === "openrouter" ? openaiToolAdapter : undefined
}

function createCustomModelConfig(modelId: string, displayName?: string): ModelConfig {
  return {
    displayName: displayName?.trim() || modelId,
    contextWindow: 128_000,
    maxOutputTokens: 32_768,
    pricingTier: "standard",
    tags: ["custom", "coding", "agent", "reasoning"],
    capabilities: {
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
      maxOutputTokens: 32_768,
    },
  }
}

// ── Factory ──

export async function createRuntime(options: RuntimeBootstrapOptions = {}): Promise<Runtime> {
  const projectRoot = options.projectRoot ?? process.cwd()
  const enableMCP = options.enableMCP ?? true
  const enableLSP = options.enableLSP ?? true
  const gateTelemetryFile = options.gateTelemetryFile ?? ".wolf/gate-telemetry.json"
  const contextMapPolicy = options.contextMapPolicy ?? "auto"
  const version = VERSION
  const globalConfigFile = options.configOptions?.globalPath

  // ── 0. Load config + auth store (PR-6) ──
  const config = loadConfig({ cwd: projectRoot, applyEnv: false, ...options.configOptions })
  const authStore = options.authStore ?? getDefaultAuthStore()
  const useEnvAuth = options.useEnvAuth ?? config.runtime?.allowEnvKeys ?? false
  const configuredProviders = new Set<string>()

  const readProviderKey = async (providerId: string): Promise<string> => {
    const providerConfig = getProviderConfig(config, providerId)
    const credentialRef = providerConfig?.credentialRef ?? `${providerId}/default`
    const explicit = providerId === "deepseek"
      ? options.dsApiKey
      : providerId === "anthropic"
        ? options.anthApiKey
        : providerId === "openai"
          ? options.openaiApiKey
          : undefined
    if (explicit) return explicit
    const fromStore = authStore.getCredential
      ? (await authStore.getCredential(credentialRef))?.apiKey
      : await authStore.get(providerId)
    if (fromStore) return fromStore
    if (!useEnvAuth) return ""
    const envKey = providerEnvKey(providerId, providerConfig)
    return envKey ? process.env[envKey] ?? "" : ""
  }

  // 默认模型来自 config（env 覆盖已在 loadConfig 中处理）
  const modelOverride = options.modelOverride
    ?? resolveModelForRole("default", config)

  // ── 1. Provider registry ──
  const registry = new ProviderRegistry()

  const registerProviderFromConfig = async (providerId: string, forceMissing = false): Promise<void> => {
    const providerConfig = getProviderConfig(config, providerId)
    const apiKey = forceMissing ? "" : await readProviderKey(providerId)
    const provider = apiKey
      ? createProviderInstance(providerId, providerConfig, apiKey)
      : new MissingAuthProvider(providerId)
    if (apiKey) configuredProviders.add(providerId)
    const defaultModel = providerId === config.defaultProvider
      ? resolveModelForRole("default", config)
      : Object.keys(providerConfig?.models ?? {})[0] ?? resolveModelForRole("default", config)
    registry.upsertProvider({
      id: providerId,
      provider,
      defaultModel,
      toolAdapter: providerToolAdapter(providerConfig),
    })
  }

  for (const providerId of Object.keys(config.providers ?? {})) {
    await registerProviderFromConfig(providerId)
  }

  const defaultProvider = config.defaultProvider ?? "deepseek"
  if (!configuredProviders.has(defaultProvider) && !options.allowMissingProviderAuth) {
    throw new Error(
      `${defaultProvider} 还没有配置 API key。请先运行 /models 选择模型并输入 key，或在 ~/.deepseek-code/auth.json 中保存 key。`,
    )
  }

  // 注册内置模型元数据（保持向后兼容）
  registry.registerBuiltinModels()

  // PR-6: 从 config 注册用户自定义模型（覆盖内置同名模型）
  for (const [providerId, providerConfig] of Object.entries(config.providers ?? {})) {
    for (const [modelId, modelConfig] of Object.entries(providerConfig.models)) {
      // provider 可能是 MissingAuthProvider；这样 /models 可在无 key 时展示 catalog。
      if (registry.getProvider(providerId) !== undefined) {
        registry.registerModel(toModelSpec(modelId, providerId, modelConfig, providerConfig))
      }
    }
  }

  const multiProvider = new MultiProvider({ registry, defaultModel: modelOverride })
  const modelRouter = new ModelRouter(registry, multiProvider)

  // ── 2. Session migration ──
  if (needsMigration()) {
    const result = migrateAllJsonSessions()
    if (result.migrated > 0 && options.mcpOnStatus) {
      options.mcpOnStatus(`已迁移 ${result.migrated} 个旧格式会话到 SQLite`)
    }
    if (result.errors.length > 0 && options.mcpOnStatus) {
      options.mcpOnStatus(`迁移错误: ${result.errors.join(", ")}`)
    }
  }

  // ── 3. MCP bootstrap ──
  let mcpResult: MCPBridgeResult = { totalServers: 0, connected: 0, failed: [], toolsDiscovered: 0, tools: [] }
  if (enableMCP) {
    mcpResult = await bootstrapMCP({
      onStatus: options.mcpOnStatus ?? (() => {}),
    })
    if (mcpResult.failed.length > 0 && options.mcpOnStatus) {
      options.mcpOnStatus(`MCP: ${mcpResult.failed.length} server(s) failed: ${mcpResult.failed.join(", ")}`)
    }
  }

  // ── 4. Tools ──
  const mcpToolDefs = mcpResult.tools
  const allToolDefs: ToolDef[] = [
    ...FILE_TOOLS,
    SHELL_TOOL,
    START_SERVICE_TOOL,
    ...GIT_TOOLS,
    WEB_SEARCH,
    WEB_FETCH_TOOL,
    ...CODEGRAPH_TOOLS,
    ...LSP_TOOLS,
    TYPECHECK_TOOL,
    ...mcpToolDefs,
    TASK_TOOL,
    REQUEST_DEEPER_THINKING,
  ]
  const tools = buildTools(...allToolDefs)

  // ── 5. Hooks ──
  const hooks = new HookSystem()
  // Before hooks: safety → writeGuardBefore (ordered: widest guard first, finest last)
  hooks.onToolBefore(createSafetyPolicyHook({ projectRoot }))
  hooks.onToolBefore(writeGuardBefore)
  // After hooks: writeGuardAfter (tracks reads) → journalGuard (vetoes on write after results)
  hooks.onToolAfter(writeGuardAfter)
  hooks.onToolAfter(createJournalGuard(projectRoot))

  // ── 5b. Dispatch SessionStart (PR-7.2) ──
  // Fire after all hooks are registered so they can inject session-level context.
  const sessionStartResult = await hooks.dispatchSessionStart({
    projectRoot,
    mode: "coder",
    toolNames: allToolDefs.map(d => d.name),
  })
  // Context injected by SessionStart hooks is available via buildAgentOptions.
  // Blocked sessions are refused immediately.
  if (sessionStartResult.blocked) {
    throw new Error(`Session blocked by hook: ${sessionStartResult.blockReason}`)
  }

  // ── 6. Context ──
  const stagedCtx = new StagedContextManager(projectRoot)

  // ── 7. Session ──
  const sessions = new SessionManager()
  let activeSessionId = sessions.create().id
  const sessionStore = new SessionStore(activeSessionId)
  registerCheckpointStore(activeSessionId, sessionStore)

  // ── 8. Memory ──
  const thinkingStore = new ThinkingStore()
  const knowledgeBase = new KnowledgeBase()
  const compactor = createCompactor()

  // ── 9. LSP ──
  const lspClient = getLSPClient(projectRoot)
  if (enableLSP) {
    lspClient.start().then(available => {
      if (available && options.mcpOnStatus) {
        options.mcpOnStatus("LSP: typescript-language-server connected")
      }
    }).catch(() => { /* silent — tsc fallback handles it */ })
  }

  // ── 10. Session switching helper ──
  const switchSession = (newId: string) => {
    if (newId === activeSessionId) return
    unregisterCheckpointStore(activeSessionId)
    activeSessionId = newId
    registerCheckpointStore(newId, new SessionStore(newId))
  }

  const configureModel = async (input: { providerId: string; modelId: string; apiKey?: string; custom?: boolean; displayName?: string; baseUrl?: string }) => {
    const currentProviderConfig = getProviderConfig(config, input.providerId)
    if (!currentProviderConfig) {
      throw new Error(`未知 provider：${input.providerId}`)
    }
    const providerConfig: ProviderConfig = {
      ...currentProviderConfig,
      ...(input.baseUrl?.trim() ? { baseUrl: input.baseUrl.trim() } : {}),
      models: { ...currentProviderConfig.models },
    }
    if (!providerConfig.models[input.modelId] && input.custom) {
      providerConfig.models[input.modelId] = createCustomModelConfig(input.modelId, input.displayName)
    }
    if (!providerConfig.models[input.modelId] && !registry.resolveModel(input.modelId)) {
      throw new Error(`未知模型：${input.modelId}`)
    }

    const key = input.apiKey?.trim()
    if (key) {
      const ref = providerConfig.credentialRef ?? `${input.providerId}/default`
      if (authStore.setCredential) {
        await authStore.setCredential({
          id: ref,
          providerId: input.providerId,
          label: ref.split("/")[1] || "default",
          apiKey: key,
          baseUrl: providerConfig.baseUrl,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
      } else {
        await authStore.set(input.providerId, key)
      }
    }
    const apiKey = key || await readProviderKey(input.providerId)
    if (!apiKey) {
      throw new Error(`还没有配置 ${providerConfig.displayName ?? input.providerId} 的 API key。`)
    }

    registry.upsertProvider({
      id: input.providerId,
      provider: createProviderInstance(input.providerId, providerConfig, apiKey),
      defaultModel: input.modelId,
      toolAdapter: providerToolAdapter(providerConfig),
    })
    for (const [modelId, modelConfig] of Object.entries(providerConfig.models)) {
      registry.registerModel(toModelSpec(modelId, input.providerId, modelConfig, providerConfig))
    }
    configuredProviders.add(input.providerId)
    multiProvider.setModelOverride(input.modelId)
    modelRouter.setSessionModel(input.modelId)
    config.defaultProvider = input.providerId
    config.models = {
      ...config.models,
      default: input.modelId,
    }
    config.providers = {
      ...config.providers,
      [input.providerId]: {
        ...providerConfig,
        ...(key ? { credentialRef: providerConfig.credentialRef ?? `${input.providerId}/default` } : {}),
      },
    }
    updateGlobalConfig(current => ({
      ...current,
      defaultProvider: input.providerId,
      models: {
        ...current.models,
        default: input.modelId,
      },
      providers: {
        ...current.providers,
        [input.providerId]: {
          ...providerConfig,
          ...(key ? { credentialRef: providerConfig.credentialRef ?? `${input.providerId}/default` } : {}),
        },
      },
    }), globalConfigFile)
  }

  const configureThinkingEffort = (effort: "auto" | "high" | "max") => {
    updateGlobalConfig(current => ({
      ...current,
      runtime: {
        ...current.runtime,
        thinkingEffort: effort,
      },
    }), globalConfigFile)
  }

  // ── 11. AgentOptions builder ──
  const buildAgentOptions = (overrides?: Partial<AgentOptions>): AgentOptions => ({
    provider: multiProvider,
    model: modelRouter.selectForPurpose("agent_main"),
    tools,
    maxRounds: 50,
    hooks,
    stagedContext: stagedCtx,
    thinkingStore,
    knowledgeBase,
    stableMemoryContext: buildStableAnchorContext(compactor),
    autoFinishOnVerifiedWrite: true,
    autoApprovePlan: false,
    modelRouter,
    sessionId: activeSessionId,
    gateTelemetryFile,
    contextMapPolicy,
    // PR-7.2: inject SessionStart context from hooks
    sessionStartContext: sessionStartResult.context.length > 0
      ? sessionStartResult.context.join("\n\n")
      : undefined,
    ...overrides,
  })

  // ── 12. RunTrace factory ──
  const startRunTrace = (prompt: string) => AgentRunTrace.start(projectRoot, prompt)

  const dispose = () => {
    // LSP cleanup
    try { lspClient.shutdown() } catch { /* ignore */ }
  }

  return {
    provider: multiProvider,
    modelRouter,
    registry,
    get modelOverride() {
      return multiProvider.currentModel
    },
    config,
    authStore,
    isProviderConfigured: (providerId: string) => configuredProviders.has(providerId),
    configureModel,
    configureThinkingEffort,

    mcpResult,
    mcpToolDefs,
    allToolDefs,
    tools,

    hooks,
    stagedCtx,
    sessions,
    get sessionId() {
      return activeSessionId
    },
    thinkingStore,
    knowledgeBase,
    compactor,
    lspClient,
    version,

    startRunTrace,
    buildAgentOptions,
    registerSessionCheckpointStore: (sid: string) => {
      const store = new SessionStore(sid)
      if (sid !== activeSessionId) {
        unregisterCheckpointStore(activeSessionId)
        activeSessionId = sid
      }
      registerCheckpointStore(sid, store)
      return store
    },
    switchSession,
    dispose,
  }
}

// Re-export commonly needed types
export type { CompactionState }
export type { AgentOptions }
export type { ToolDef, ToolDescriptor }
