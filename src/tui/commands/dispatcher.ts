import type React from "react"
import type { Runtime } from "../../runtime/bootstrap"
import type { ThinkEffort } from "../components/AppShell"
import { StreamEventAdapter } from "../state/event-adapter"
import { TuiStore } from "../state/tui-store"
import type { TuiState } from "../state/types"
import { selectEvidenceSummary, selectGateSummary } from "../state/selectors"
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
  exit: () => never
  openModels: (provider?: string) => void
  openEffort: () => void
  setThinkEffort: (value: ThinkEffort) => void
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
  lines.push("  2. Auth file (~/.deepseek-code/auth.json, mode 0600):")
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
      context.exit()
      // context.exit() is typed () => never (calls process.exit), but guard against
      // non-terminal implementations (e.g. in tests where exit throws instead)
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
      context.openModels(arg)
      return "handled"
    case "connect":
      context.openModels(arg)
      return "handled"
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
    default:
      return "pass_to_agent"
  }
}
