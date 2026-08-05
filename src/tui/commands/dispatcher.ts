import type React from "react"
import type { Runtime } from "../../runtime/bootstrap"
import type { ThinkEffort } from "../components/AppShell"
import { StreamEventAdapter } from "../state/event-adapter"
import { TuiStore } from "../state/tui-store"
import type { TuiState } from "../state/types"
import { selectEvidenceSummary, selectGateSummary } from "../state/selectors"
import { cleanAgentError } from "../state/adapter-helpers"
import { resolveRuntimeControlIntent } from "../../runtime/control-plane"
import { COMMANDS, formatHelpText } from "./registry"

type ModelHistoryRole = "user" | "assistant"

export interface TuiCommandContext {
  runtime: Runtime
  store: TuiStore
  adapter: StreamEventAdapter
  historyRef: React.MutableRefObject<Array<{ role: ModelHistoryRole; content: string }>>
  setClarification: (value: null) => void
  addSystemMessage: (content: string) => void
  isRunning: () => boolean
  /** 退出（main.tsx 注入双按保护：第一次提示确认，第二次真正退出）。 */
  exit: () => void
  openModels: (provider?: string) => void
  openEffort: () => void
  setThinkEffort: (value: ThinkEffort) => void
  /** Depthline P3: 分发键盘动作（Command → Action 映射）。 */
  dispatchAction: (id: string) => void
}

export type TuiCommandDispatchResult = "handled" | "pass_to_agent" | "not_command"

function formatRippleStatus(state: TuiState): string {
  if (state.rippleFindings.length === 0) {
    return "No ripple findings yet. Run a task to trigger ripple scan."
  }
  const lines = state.rippleFindings.map(f => `  ${f.file} [${f.severity}] ${f.reason}`)
  return `Ripple findings (${state.rippleFindings.length}):\n${lines.join("\n")}`
}

function formatGateStatus(state: TuiState): string {
  const summary = selectGateSummary(state)
  if (summary.total === 0) return "No gates recorded yet."
  const lines = state.gates.map(g => `  ${g.gate}: ${g.status}${g.reason ? ` - ${g.reason}` : ""}`)
  return `Gates (${summary.total}: ${summary.pass} pass / ${summary.block} block / ${summary.skip} skip):\n${lines.join("\n")}`
}

function formatEvidenceStatus(state: TuiState): string {
  const summary = selectEvidenceSummary(state)
  if (summary.total === 0) return "No evidence recorded yet."
  const lines = state.evidence.map(e => `  ${e.kind}: ${e.status} - ${e.summary}`)
  return `Evidence (${summary.total}: ${summary.passed} passed / ${summary.failed} failed / ${summary.skipped} skipped):\n${lines.join("\n")}`
}

function formatPatchStatus(state: TuiState): string {
  if (state.patches.length === 0) return "No patch transactions yet."
  const lines = state.patches.map(p => `  ${p.txId}: ${p.status} - ${p.files.length} files${p.summary ? ` - ${p.summary}` : ""}`)
  return `Patches (${state.patches.length}):\n${lines.join("\n")}`
}

function formatStats(state: TuiState, historyLength: number): string {
  return [
    `messages ${historyLength}`,
    `model ${state.modelName}`,
    `tokens in ${state.tokens.inputTokens} / out ${state.tokens.outputTokens} / max ${state.tokens.contextMax}`,
    `cache hit ${state.tokens.cacheHitRate ?? 0}%`,
    `round ${state.round}`,
  ].join("  ·  ")
}

function formatModels(runtime: Runtime, state: TuiState, provider?: string): string {
  const allModels = runtime.registry.allModels
  const providers = provider
    ? [...new Set(allModels.filter(m => m.providerId === provider).map(m => m.providerId))]
    : [...new Set(allModels.map(m => m.providerId))].sort()
  const lines: string[] = [
    `Current: ${state.modelName}`,
    `Provider: ${state.session.provider ?? runtime.registry.listProviders()[0] ?? "none"}`,
    "",
  ]

  for (const pid of providers) {
    const models = allModels.filter(m => m.providerId === pid)
    if (models.length === 0) continue
    lines.push(`  [${pid}]`)
    for (const m of models) {
      const mark = m.id === state.modelName ? " *" : "  "
      const tier = m.pricingTier ?? "?"
      const think = m.thinking?.supported ? "think" : ""
      lines.push(`${mark} ${m.id}  (${tier}${think ? ` · ${think}` : ""})  - ${m.displayName}`)
    }
    lines.push("")
  }

  if (providers.length === 0) {
    lines.push("No models registered. Use /connect to set up a provider.")
  }
  lines.push("Tip: 在 TUI 中运行 /models 可直接选择模型并保存 API key。")
  return lines.join("\n")
}

function formatConnect(runtime: Runtime, provider?: string): string {
  const registered = runtime.registry.listProviders()
  const knownProviders = ["deepseek", "anthropic", "openai"]
  const targets = provider ? [provider] : knownProviders
  const envVarMap: Record<string, string> = {
    deepseek: "DEEPSEEK_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
  }
  const lines: string[] = ["Provider connection status:"]
  for (const pid of targets) {
    const connected = (registered as readonly string[]).includes(pid)
    const envVar = envVarMap[pid]
    const hasEnv = envVar ? Boolean(process.env[envVar]) : false
    const status = connected ? "connected" : hasEnv ? "env-only" : "not configured"
    lines.push(`  ${pid}: ${status}`)
  }
  lines.push("")
  lines.push("Setup methods (pick one):")
  lines.push("  1. Environment variable (recommended for CI):")
  for (const pid of targets) {
    const envVar = envVarMap[pid]
    if (envVar) lines.push(`     export ${envVar}=<your-key>`)
  }
  lines.push("  2. Auth file (~/.orcana/auth.json, mode 0600):")
  lines.push('     {"deepseek": "sk-xxx", "anthropic": "sk-ant-xxx"}')
  lines.push("  3. Config file (orcana.jsonc) - see /help")
  lines.push("")
  lines.push("After setting a key, restart the TUI to activate the provider.")
  if (provider && !knownProviders.includes(provider)) {
    lines.unshift(`Unknown provider '${provider}'. Known: ${knownProviders.join(", ")}`)
  }
  return lines.join("\n")
}

function formatStatus(state: TuiState): string {
  const gateSummary = selectGateSummary(state)
  const evidenceSummary = selectEvidenceSummary(state)
  return [
    `Status: ${state.status}`,
    `Model: ${state.modelName}`,
    `Mode: ${state.mode}`,
    `Round: ${state.round}`,
    `Done: ${state.done ? "yes" : "no"}`,
    `Queue: ${state.queueCount}`,
    `Tokens: ${state.tokens.inputTokens} in / ${state.tokens.outputTokens} out / ${state.tokens.contextMax} max`,
    `Cache: ${state.tokens.cacheHitRate ?? 0}%`,
    `Gates: ${gateSummary.pass}p/${gateSummary.block}b/${gateSummary.skip}s`,
    `Evidence: ${evidenceSummary.passed}p/${evidenceSummary.failed}f/${evidenceSummary.skipped}s`,
    `Tools: ${state.tools.length}`,
    `Patches: ${state.patches.length}`,
  ].join("\n")
}

/** 解析 /models 参数：<模型ID> 直接切换；<provider> 开过滤对话框；无匹配给提示。 */
type ModelArgIntent =
  | { kind: "dialog"; provider?: string }
  | { kind: "switch"; providerId: string; modelId: string; displayName: string }
  | { kind: "notfound"; providers: string[] }

export function resolveModelArg(runtime: Runtime, arg: string | undefined): ModelArgIntent {
  if (!arg) return { kind: "dialog" }
  const needle = arg.trim().toLowerCase()
  const all = runtime.registry.allModels
  const providers = [...new Set(all.map(m => m.providerId))].sort()
  const exact = all.find(m => m.id.toLowerCase() === needle)
  if (exact) return { kind: "switch", providerId: exact.providerId, modelId: exact.id, displayName: exact.displayName ?? exact.id }
  const asProvider = providers.find(p => p.toLowerCase() === needle)
  if (asProvider) return { kind: "dialog", provider: asProvider }
  const partial = all.filter(m => m.id.toLowerCase().includes(needle))
  if (partial.length === 1) {
    const m = partial[0]!
    return { kind: "switch", providerId: m.providerId, modelId: m.id, displayName: m.displayName ?? m.id }
  }
  return { kind: "notfound", providers }
}

/** 应用模型切换（configureModel + store 状态 + 活动消息）。 */
function applyModelSwitch(
  context: TuiCommandContext,
  target: { providerId: string; modelId: string; displayName: string },
): void {
  void context.runtime.configureModel({ providerId: target.providerId, modelId: target.modelId })
    .then(() => {
      context.store.dispatch({ type: "ui.model_name", name: target.modelId })
      context.store.dispatch({
        type: "session.started",
        sessionId: context.runtime.sessionId,
        repoRoot: process.cwd(),
        provider: target.providerId,
        model: target.modelId,
      })
      context.store.dispatch({ type: "ui.error_line", text: "" })
      context.addSystemMessage(`模型已切换：${target.providerId} / ${target.displayName}`)
    })
    .catch(err => {
      context.addSystemMessage(`切换模型失败：${cleanAgentError(err instanceof Error ? err.message : String(err))}`)
    })
}

function formatProvidersList(providers: string[]): string {
  if (providers.length === 0) return "（无已注册模型）"
  return providers.join(", ")
}

export function dispatchTuiCommand(input: string, context: TuiCommandContext): TuiCommandDispatchResult {
  const intent = resolveRuntimeControlIntent(input, COMMANDS, { isRunning: context.isRunning() })
  if (intent.kind === "agent_prompt" || intent.kind === "empty") return "not_command"
  if (intent.kind === "unknown_command") return "pass_to_agent"
  if (intent.kind === "blocked_command") {
    context.addSystemMessage(`${intent.reason} Wait for it to finish or use /status to check progress.`)
    return "handled"
  }

  const state = context.store.getState()
  const name = intent.canonicalName
  const arg = intent.argv[0]

  switch (name) {
    case "exit":
      // main.tsx 注入的 exit 带双按保护：第一次提示"再输入一次 /exit 确认"，第二次才退出
      context.exit()
      return "handled"
    case "help":
      context.addSystemMessage(formatHelpText())
      return "handled"
    case "clear":
      context.historyRef.current = []
      context.setClarification(null)
      context.adapter.reset()
      context.store.reset()
      return "handled"
    case "stats":
      context.addSystemMessage(formatStats(state, context.historyRef.current.length))
      return "handled"
    case "ripple":
      context.addSystemMessage(formatRippleStatus(state))
      return "handled"
    case "gates":
      context.addSystemMessage(formatGateStatus(state))
      return "handled"
    case "evidence":
      context.addSystemMessage(formatEvidenceStatus(state))
      return "handled"
    case "patches":
      context.addSystemMessage(formatPatchStatus(state))
      return "handled"
    case "models":
    case "connect": {
      const modelArg = resolveModelArg(context.runtime, arg)
      if (modelArg.kind === "switch") {
        applyModelSwitch(context, modelArg)
        return "handled"
      }
      if (modelArg.kind === "notfound") {
        context.addSystemMessage(`未找到模型或 provider：${arg}。可用 provider：${formatProvidersList(modelArg.providers)}。\n可用 /models <模型ID> 直接切换，或 /models 打开选择器。`)
        return "handled"
      }
      context.openModels(modelArg.provider)
      return "handled"
    }
    case "effort": {
      const value = arg
      if (value === "auto" || value === "high" || value === "max") {
        context.setThinkEffort(value)
      } else if (value) {
        context.addSystemMessage(`推理深度只支持 auto / high / max。当前输入：${value}`)
      } else {
        context.openEffort()
      }
      return "handled"
    }
    case "status":
      context.addSystemMessage(formatStatus(state))
      return "handled"
    default: {
      // Depthline P3: Command → Action 映射（如 /runtime → runtime.open）
      const def = COMMANDS.find(c => c.name === name)
      if (def?.actionId) {
        context.dispatchAction(def.actionId)
        return "handled"
      }
      // 已注册但未接入实现的命令：明确提示，绝不静默发给 agent。
      if (def?.enabled === false) {
        context.addSystemMessage(`/${name} 暂不可用：${def.disabledReason ?? "未接入"}`)
        return "handled"
      }
      return "pass_to_agent"
    }
  }
}
