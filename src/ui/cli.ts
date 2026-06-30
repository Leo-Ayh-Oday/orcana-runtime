/** DeepSeek Code v0.3.0 readline UI with streaming output and Chinese status text.
 *
 *  Assembly is delegated to createRuntime() — this file is now a thin UX layer.
 */

import { agentLoop } from "../agent/loop"
import { ModelRouter } from "../provider/router"
import type { ToolDescriptor } from "../tools/registry"
import { StagedContextManager } from "../context/staged"
import { SessionManager, SessionCorruptedError, searchAllSessions } from "../session"
import { lastCheckpoint, verifyCheckpoint } from "../session/checkpoint"
import type { SessionCheckpoint } from "../session/checkpoint"
import { saveRewindPoint } from "../agent/rewind"
import { buildResumeContext, resumeMessages } from "../session/summarizer"
import { ThinkingStore } from "../memory/thinking-store"
import { KnowledgeBase } from "../memory/knowledge"
import {
  addTurn,
  buildDynamicMemoryContext,
  buildStableAnchorContext,
  createBaseCheckpoint,
  restoreCompactorState,
  saveCompactorState,
} from "../memory/compactor"
import type { CompactionState } from "../memory/compactor"
import type { UsageStats } from "../agent/loop"
import { createStreamRenderState, dim, flushStreamRender, green, yellow, red, renderResponse, renderStreamChunk } from "./render"
import { reprompt, startInput } from "./input"
import { CommandRegistry } from "./commands/registry"
import { createBuiltinCommands } from "./commands/definitions"
import { formatCacheAnatomyHud, formatTokenHud } from "./token-hud"
import { closeToolCalls, createToolTraceState, renderToolCall, renderToolResult, renderToolStatus } from "./tool-trace"
import { shouldUseChatLite } from "./chat-lite"
import { shouldSkipProviderPurpose } from "../provider/cost-policy"
import { playStartupScreen } from "./startup-screen"
import { playInkStartupScreen } from "./ink-startup"
import { HookSystem } from "../hooks"
import { AgentRunTrace } from "../agent/run-trace"
import { findPendingClarification } from "../agent/clarification"
import { createRuntime } from "../runtime/bootstrap"
import type { MultiProvider } from "../provider/multi"

const formatK = (n: number) => n >= 1000 ? `${Math.round(n / 1000)}K` : String(n)
const LITE_CONTEXT_MAX = 1_000_000
const CHAT_LITE_SYSTEM = "你是 DeepSeek Code。当前是轻聊天模式：简短回应用户，不读取文件，不调用工具，不做项目分析。"

let sessionInputTokens = 0
let sessionOutputTokens = 0
let sessionMs = 0
let prevInput = 0
let prevOutput = 0
let lastUsage: UsageStats | null = null

interface TokenUsageEvent {
  requestedModel?: string
  actualModel?: string
  inputTokens: number
  outputTokens: number
  contextMax: number
  roundMs?: number
  cacheHitRate?: number
  cacheSource?: string
  contextUsagePercent?: number
  cacheReadInputTokens?: number
  cacheMissInputTokens?: number
  cacheCreationInputTokens?: number
  outputShare?: number
  missShare?: number
  claudeStyleCacheShape?: boolean
  cacheAnatomy?: { stableTokens: number; volatileTokens: number }
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function replaceCompactorState(compactor: CompactionState, next: CompactionState) {
  Object.assign(compactor, next)
}

function rememberTurn(compactor: CompactionState, turn: { role: "user" | "assistant"; content: string }) {
  replaceCompactorState(compactor, addTurn(compactor, turn))
}

function maybeCreateM0(compactor: CompactionState, title: string) {
  const thresholdTokens = envNumber("DEEPSEEK_M0_THRESHOLD_TOKENS", 50_000)
  if (compactor.anchor || compactor.estimatedTokens < thresholdTokens) return
  replaceCompactorState(compactor, createBaseCheckpoint(compactor, {
    sessionId: "auto-m0",
    thresholdTokens,
    title: title.slice(0, 140),
  }))
}


export async function startCLI(cliPrompt?: string, resumeId?: string) {
  const undoStack: Array<{ path: string; previousContent: string | null }> = []

  // ── Shared runtime assembly ──
  const runtime = await createRuntime({
    projectRoot: process.cwd(),
    mcpOnStatus: (msg) => { process.stderr.write(`${msg}\n`) },
  })
  const modelRouter = runtime.modelRouter
  const multiProvider = runtime.provider
  const tools = runtime.tools
  const hooks = runtime.hooks
  const stagedCtx = runtime.stagedCtx
  const sessions = runtime.sessions
  const thinkingStore = runtime.thinkingStore
  const knowledgeBase = runtime.knowledgeBase
  const modelOverride = runtime.modelOverride

  let sessionId = resumeId || runtime.sessionId
  let thinkEffort: "auto" | "high" | "max" = "auto"
  const history: Array<{ role: "user" | "assistant"; content: string }> = []

  let resumeFromCheckpoint: SessionCheckpoint | null = null

  if (resumeId) {
    try {
      const restored = sessions.load(resumeId)
      if (restored) {
        const stagedFiles = (restored.metadata?.stagedFiles as string[]) ?? []
        for (const f of stagedFiles) { try { stagedCtx.markLoaded(f) } catch { } }
        // ── Checkpoint recovery: if checkpoint exists, verify and load ──
        const cp = lastCheckpoint(resumeId)
        if (cp) {
          const integrity = verifyCheckpoint(cp)
          if (integrity.valid) {
            resumeFromCheckpoint = cp
            const stepsDone = cp.taskSteps.filter(s => s.status === "done").length
            console.log(green(
              `从检查点恢复 (round ${cp.round}, ${stepsDone}/${cp.taskSteps.length} 步骤, ${cp.changedFiles.length} 文件)`
            ))
          } else {
            console.log(yellow(
              `检查点文件已变更 (${integrity.filesMismatched.length} 个不匹配)，从对话历史恢复`
            ))
            history.push({ role: "assistant", content: buildResumeContext(restored) })
          }
        } else {
          history.push({ role: "assistant", content: buildResumeContext(restored) })
        }
        for (const m of resumeMessages(restored)) history.push(m)
        sessionId = resumeId
      } else {
        console.log(yellow(`会话 ${resumeId} 不存在，创建新会话`))
      }
    } catch (e) {
      if (e instanceof SessionCorruptedError) {
        console.log(yellow(`会话 ${resumeId} 已损坏（${e.message}），创建新会话`))
      } else {
        throw e
      }
    }
  }
  runtime.switchSession(sessionId)

  const startupOptions = {
    version: runtime.version,
    toolsCount: tools.length,
    thinkingEffort: thinkEffort,
    modelName: modelOverride ?? "deepseek-v4-pro",
  }
  const usedInkStartup = await playInkStartupScreen(startupOptions).catch(() => false)
  if (!usedInkStartup) await playStartupScreen(startupOptions)

  // Use runtime's compactor but restore resume state if needed
  const compactor = runtime.compactor
  if (resumeId) restoreCompactorState(compactor, resumeId)

  if (cliPrompt) {
    process.stdout.write(`${dim(">")}  ${cliPrompt}\n\n`)
    try {
      if (shouldUseChatLite(cliPrompt) && !shouldSkipProviderPurpose("chat_lite")) await runLiteTurn(multiProvider, modelRouter, cliPrompt, history, compactor)
      else await runTurn(multiProvider, modelRouter, tools, cliPrompt, stagedCtx, thinkingStore, compactor, history, undoStack, knowledgeBase, thinkEffort, hooks, sessionId, resumeFromCheckpoint)
    } finally {
      runtime.dispose()
    }
    return
  }

  // ── Safe session ID setter — re-registers checkpoint store on change ──
  const setSessionId = (id: string) => {
    if (id !== sessionId) {
      sessionId = id
      runtime.switchSession(id)
    }
  }

  // ── Rewind state (PR-4.3) ──
  let currentRound = 0
  const roundFileTransactionIds: string[] = []
  // Track which round each transaction was created in
  const transactionRoundMap = new Map<string, number>()
  function trackTransaction(txId: string, round: number) {
    roundFileTransactionIds.push(txId)
    transactionRoundMap.set(txId, round)
  }
  function getTransactionIdsSinceRound(targetRound: number): string[] {
    return roundFileTransactionIds.filter(txId => (transactionRoundMap.get(txId) ?? 0) >= targetRound)
  }

  // ── Command registry ──
  const commandRegistry = new CommandRegistry()
  const cmdCtx = {
    history,
    stagedCtx,
    sessions,
    thinkingStore,
    knowledgeBase,
    compactor,
    sessionId,
    undoStack,
    thinkEffort,
    hooks,
    setThinkEffort: (val: "auto" | "high" | "max") => { thinkEffort = val },
    setSessionId,
    showHelp: () => { console.log(commandRegistry.buildHelp() + "\n") },
    reprompt: () => {},
  }
  for (const def of createBuiltinCommands({
    getSessionTokens: () => ({ input: sessionInputTokens, output: sessionOutputTokens, ms: sessionMs }),
    resetSessionTokens: () => { sessionInputTokens = 0; sessionOutputTokens = 0; sessionMs = 0 },
    getLastUsage: () => lastUsage,
    rewind: {
      getCurrentRound: () => currentRound,
      getTransactionIds: () => getTransactionIdsSinceRound(currentRound > 0 ? currentRound : 1),
      truncateHistoryToRound: (targetRound: number) => {
        // Truncate conversation: remove all messages after the target round's user prompt
        // Each round is a user→assistant pair; find the right boundary
        let userMsgCount = 0
        let truncateIdx = history.length
        for (let i = 0; i < history.length; i++) {
          if (history[i]!.role === "user") {
            userMsgCount++
            if (userMsgCount > targetRound) {
              truncateIdx = i
              break
            }
          }
        }
        history.length = truncateIdx
      },
      getSessionId: () => sessionId,
    },
  })) {
    commandRegistry.register(def)
  }

  const rl = startInput(async (input: string) => {
    rl.pause()

    // Dispatch slash commands through registry
    if (input.startsWith("/")) {
      const handled = commandRegistry.execute(input, { ...cmdCtx, reprompt: () => reprompt(rl) })
      if (handled) { reprompt(rl); return }
    }

    // PR-4.3: Auto-save rewind point on each user prompt
    currentRound++
    try {
      saveRewindPoint({
        sessionId: sessionId || `unsaved-${Date.now().toString(36)}`,
        round: currentRound,
        summary: input.slice(0, 200),
        changedFiles: undoStack.map(s => s.path),
        fileSHAs: {},
        conversationTokens: history.reduce((sum, h) => sum + h.content.length, 0),
      })
    } catch {
      // Non-critical — rewind auto-save failure shouldn't block the turn
    }

    lastUsage = null
    if (shouldUseChatLite(input) && !shouldSkipProviderPurpose("chat_lite") && !findPendingClarification(history)) await runLiteTurn(multiProvider, modelRouter, input, history, compactor)
    else await runTurn(multiProvider, modelRouter, tools, input, stagedCtx, thinkingStore, compactor, history, undoStack, knowledgeBase, thinkEffort, hooks, sessionId, resumeFromCheckpoint)
    if (history.length % 5 === 0 && history.length > 0) {
      setSessionId(persistSession(sessions, history, stagedCtx, compactor, sessionId, !sessionId))
    }
    reprompt(rl)
  })

  if (resumeId) {
    setTimeout(() => reprompt(rl), 50)
  }
}

function showStats(sessionId: string, msgCount: number, fileCount: number) {
  console.log(dim(`会话: ${sessionId || "(未保存)"}  |  消息: ${msgCount}  |  文件: ${fileCount}`))
  if (lastUsage) {
    const u = lastUsage
    const hr = u.apiCalls > 0 ? Math.round(u.cacheHits / u.apiCalls * 100) : 0
    console.log(dim(`API: ${u.apiCalls} 次 | Flash ${u.flashRounds} Pro ${u.proRounds} | ${Math.round(u.estimatedInputTokens / 1000)}K | 缓存 ${hr}%`))
  }
  console.log(dim(`累计: ${formatK(sessionInputTokens + sessionOutputTokens)} tokens | ${(sessionMs / 1000).toFixed(0)}s\n`))
}

function persistSession(
  sessions: SessionManager,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  stagedCtx: StagedContextManager,
  compactor: CompactionState,
  sessionId: string,
  isNew: boolean,
  /** Optional: update active SessionStore when session ID changes (first save). */
  onNewId?: (oldId: string, newId: string) => void,
): string {
  const s = isNew
    ? sessions.create({ topic: history[0]?.content?.slice(0, 50), messageCount: history.length })
    : (() => { try { return sessions.load(sessionId) } catch { return null } })()
      ?? sessions.create({ topic: history[0]?.content?.slice(0, 50), messageCount: history.length })
  s.messages = history.map(h => ({ role: h.role as "user" | "assistant", content: h.content, timestamp: Date.now(), metadata: {} }))
  s.metadata = { ...s.metadata, messageCount: history.length, stagedFiles: [...stagedCtx.loadedFiles.keys()] }
  sessions.save(s)
  saveCompactorState(compactor, s.id)

  // Notify that the session ID changed (first save)
  if (onNewId && s.id !== sessionId) {
    onNewId(sessionId, s.id)
  }
  return s.id
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 3))
}

async function runLiteTurn(
  provider: MultiProvider,
  router: ModelRouter,
  prompt: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  compactor: CompactionState,
) {
  const started = Date.now()
  const streamRender = createStreamRenderState()
  const recentHistory = history
    .slice(-4)
    .filter(item => item.content.length <= 500)
  const messages = [
    ...recentHistory,
    { role: "user" as const, content: prompt },
  ]

  const inputTokens = estimateTokens(CHAT_LITE_SYSTEM + JSON.stringify(messages))
  let outputText = ""
  let streamedTextStarted = false
  const liteModel = router.selectForPurpose("chat_lite")

  for await (const event of provider.streamChat({
    model: liteModel,
    purpose: "chat_lite",
    system: CHAT_LITE_SYSTEM,
    messages,
    maxTokens: 512,
  })) {
    if (event.type === "text") {
      if (!streamedTextStarted) {
        process.stdout.write(dim("DS  "))
        streamedTextStarted = true
      }
      const chunk = String(event.data ?? "")
      process.stdout.write(renderStreamChunk(streamRender, chunk))
      outputText += chunk
    } else if (event.type === "error") {
      process.stdout.write(red(`  ✗ ${event.data}\n`))
    }
  }

  if (streamedTextStarted) {
    const tail = flushStreamRender(streamRender)
    if (tail) process.stdout.write(tail)
    process.stdout.write("\n")
  }

  const outputTokens = estimateTokens(outputText)
  sessionInputTokens += inputTokens
  sessionOutputTokens += outputTokens
  const elapsedMs = Date.now() - started
  sessionMs += elapsedMs
  const total = formatTokenHud({
    inputTokens: sessionInputTokens,
    outputTokens: sessionOutputTokens,
    contextMax: LITE_CONTEXT_MAX,
  })
  console.log(dim(`[轻聊天 本轮 ~${formatK(inputTokens + outputTokens)} tokens | 上下文 ${total} | 耗时 ${(elapsedMs / 1000).toFixed(1)}s]`))

  rememberTurn(compactor, { role: "user", content: prompt })
  if (outputText) rememberTurn(compactor, { role: "assistant", content: outputText })
  maybeCreateM0(compactor, prompt)
  history.push({ role: "user", content: prompt })
  if (outputText) history.push({ role: "assistant", content: outputText })
}

async function runTurn(
  provider: MultiProvider,
  router: ModelRouter,
  tools: ToolDescriptor[],
  prompt: string,
  stagedCtx: StagedContextManager,
  thinkingStore: ThinkingStore,
  compactor: CompactionState,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  _undoStack: Array<{ path: string; previousContent: string | null }>,
  knowledgeBase: KnowledgeBase,
  thinkEffort: "auto" | "high" | "max",
  hooks: HookSystem,
  sessionId: string,
  resumeFromCheckpoint: SessionCheckpoint | null,
) {
  prevInput = 0
  prevOutput = 0
  let lastText = ""
  let streamedTextStarted = false
  const streamRender = createStreamRenderState()
  const toolTrace = createToolTraceState()
  let tokenData: TokenUsageEvent | null = null
  let cumulativeCacheRead = 0
  let cumulativeCacheMiss = 0
  let cumulativeCacheCreation = 0
  let totalMs = 0
  let printedToolTrace = false

  const isTTY = process.stdout.isTTY
  const frames = ["-", "\\", "|", "/"]
  let si = 0
  let spinnerActive = Boolean(isTTY)
  let spinnerNote = ""
  const renderSpinner = () => {
    const sIn = sessionInputTokens + prevInput
    const note = spinnerNote ? `  ${spinnerNote}` : ""
    process.stdout.write(`\r\x1b[K${dim(`${frames[si++ % frames.length]} 思考中`)}${dim(note)}  ${dim(`累计 ${formatK(sIn)} tokens`)}`)
  }
  const stopTransientStatus = () => {
    spinnerActive = false
    if (isTTY) process.stdout.write("\r\x1b[K")
  }
  const spinnerTimer = setInterval(() => {
    if (!spinnerActive) return
    renderSpinner()
  }, 80)

  maybeCreateM0(compactor, prompt)
  const stableMemoryContext = buildStableAnchorContext(compactor)
  const dynamicMemoryContext = buildDynamicMemoryContext(compactor)
  const warmHistory = dynamicMemoryContext
    ? [...history, { role: "assistant" as const, content: dynamicMemoryContext }]
    : [...history]
  const runTrace = AgentRunTrace.start(process.cwd(), prompt)
  let planNeedsReinvoke = false

  const opts: Record<string, unknown> = {
    provider,
    model: router.selectForPurpose("agent_main"),
    tools,
    conversationHistory: warmHistory,
    stagedContext: stagedCtx,
    thinkingStore,
    knowledgeBase,
    thinkEffort: thinkEffort === "auto" ? undefined : thinkEffort,
    stableMemoryContext,
    hooks,
    autoFinishOnVerifiedWrite: true,
    autoApprovePlan: Boolean(prompt) || process.stdin?.isTTY !== true,
    runTrace,
    sessionId,
    modelRouter: router,
    gateTelemetryFile: ".wolf/gate-telemetry.json",
    contextMapPolicy: "auto" as const,
    ...(resumeFromCheckpoint ? { resumeFromCheckpoint } : {}),
  }

  do {
  try {
    planNeedsReinvoke = false
    for await (const event of agentLoop(prompt, opts as unknown as Parameters<typeof agentLoop>[1])) {
      switch (event.type) {
        case "text":
          stopTransientStatus()
          if (!streamedTextStarted) {
            const closed = closeToolCalls(toolTrace)
            if (closed) { process.stdout.write(closed); printedToolTrace = true }
            if (printedToolTrace) process.stdout.write("\n")
            process.stdout.write(dim("DS  "))
            streamedTextStarted = true
          }
          process.stdout.write(renderStreamChunk(streamRender, String(event.data ?? "")))
          lastText += String(event.data ?? "")
          break

        case "tool_call": {
          stopTransientStatus()
          const data = event.data as { name: string; input?: Record<string, unknown> }
          const out = renderToolCall(toolTrace, data.name, data.input ?? {})
          if (out) printedToolTrace = true
          if (out) process.stdout.write(out + "\n")
          if (isTTY) {
            spinnerNote = "执行工具"
            spinnerActive = true
            renderSpinner()
          }
          break
        }

        case "tool_result": {
          stopTransientStatus()
          const data = event.data as { name: string; content: string }
          const out = renderToolResult(toolTrace, data.name, String(data.content ?? ""))
          if (out) printedToolTrace = true
          process.stdout.write(out)
          break
        }

        case "status": {
          const status = String(event.data ?? "")
          const out = renderToolStatus(toolTrace, status)
          if (out) {
            stopTransientStatus()
            printedToolTrace = true
            process.stdout.write(out)
          } else if (isTTY) {
            spinnerNote = /^(thinking|working|continue)$/i.test(status) ? "" : status
            spinnerActive = true
            renderSpinner()
          }
          break
        }

        case "token_usage": {
          tokenData = event.data as TokenUsageEvent
          if (!tokenData) break
          if (tokenData.roundMs) totalMs += tokenData.roundMs
          if (tokenData.roundMs && tokenData.cacheSource === "provider") {
            cumulativeCacheRead += tokenData.cacheReadInputTokens ?? 0
            cumulativeCacheMiss += tokenData.cacheMissInputTokens ?? 0
            cumulativeCacheCreation += tokenData.cacheCreationInputTokens ?? 0
          }
          const dInput = tokenData.inputTokens - prevInput
          const dOutput = tokenData.outputTokens - prevOutput
          if (dInput > 0) sessionInputTokens += dInput
          if (dOutput > 0) sessionOutputTokens += dOutput
          prevInput = tokenData.inputTokens
          prevOutput = tokenData.outputTokens
          break
        }

        case "plan_ready": {
          stopTransientStatus()
          const data = event.data as {
            planText: string; score: number; signals: string[];
            goal: string; steps: Array<{ id: string; title: string }>;
            requiredFiles: string[]; requiredVerificationKinds: string[];
            missingItems: string[];
          }
          process.stdout.write("\n" + yellow("=== 执行计划 (请审核) ===") + "\n")
          process.stdout.write(`目标: ${data.goal}\n`)
          process.stdout.write(`质量评分: ${data.score}/8\n`)
          if (data.missingItems.length > 0) {
            process.stdout.write(yellow("注意事项: " + data.missingItems.join("; ")) + "\n")
          }
          process.stdout.write("\n步骤:\n")
          for (const step of data.steps) {
            process.stdout.write(`  - ${step.title}\n`)
          }
          process.stdout.write(`\n交付文件: ${data.requiredFiles.join(", ")}\n`)
          process.stdout.write(`验证: ${data.requiredVerificationKinds.join(", ")}\n`)
          process.stdout.write("\n")
          const answer = await new Promise<string>(resolve => {
            const { stdin, stdout } = process
            stdout.write(yellow("[Y] 批准执行  [n] 修改计划  [x] 取消] "))
            const onData = (data: Buffer) => {
              stdin.removeListener("data", onData)
              if (stdin.isTTY) stdin.setRawMode(false)
              resolve(data.toString().trim())
            }
            if (stdin.isTTY) stdin.setRawMode(true)
            stdin.on("data", onData)
          })
          const normalized = answer.trim().toLowerCase()
          if (normalized === "" || normalized === "y" || normalized === "yes") {
            opts.initialPlanState = "approved"
            planNeedsReinvoke = true
          } else if (normalized === "x" || normalized === "cancel") {
            process.stdout.write(red("计划已取消\n"))
            return
          } else {
            warmHistory.push({ role: "user", content: `用户要求修改计划：${answer}` })
            planNeedsReinvoke = true
          }
          break
        }

        case "error":
          stopTransientStatus()
          process.stdout.write(red(`  ✗ ${event.data}\n`))
          break
      }
    }
  } finally {
    stopTransientStatus()
    clearInterval(spinnerTimer)
  }
  } while (planNeedsReinvoke)

  process.stdout.write(closeToolCalls(toolTrace))

  if (streamedTextStarted) {
    const tail = flushStreamRender(streamRender)
    if (tail) process.stdout.write(tail)
    process.stdout.write("\n")
  }
  if (lastText && !streamedTextStarted) {
    process.stdout.write(dim("DS  ") + renderResponse(lastText) + "\n")
  }

  sessionMs += totalMs
  if (tokenData) {
    const turnTokens = Math.max(0, tokenData.inputTokens + tokenData.outputTokens)
    const total = formatTokenHud({
      inputTokens: sessionInputTokens,
      outputTokens: sessionOutputTokens,
      contextMax: tokenData.contextMax,
    })
    const parts = [`本轮 ~${formatK(turnTokens)} tokens`]
    const cumulativeCacheTotal = cumulativeCacheRead + cumulativeCacheMiss
    const cacheHud = formatCacheAnatomyHud({
      ...tokenData,
      cumulativeCacheReadInputTokens: cumulativeCacheTotal > 0 ? cumulativeCacheRead : undefined,
      cumulativeCacheMissInputTokens: cumulativeCacheTotal > 0 ? cumulativeCacheMiss : undefined,
      cumulativeCacheCreationInputTokens: cumulativeCacheCreation > 0 ? cumulativeCacheCreation : undefined,
      cumulativeCacheHitRate: cumulativeCacheTotal > 0 ? Math.round((cumulativeCacheRead / cumulativeCacheTotal) * 100) : undefined,
    })
    if (cacheHud) parts.push(cacheHud)
    parts.push(`上下文 ${total}${typeof tokenData.contextUsagePercent === "number" ? ` (${tokenData.contextUsagePercent}%)` : ""}`)
    if (totalMs > 0) parts.push(`耗时 ${(totalMs / 1000).toFixed(1)}s`)
    console.log(dim(`[${parts.join(" | ")}]`))
  }

  rememberTurn(compactor, { role: "user", content: prompt })
  if (lastText) rememberTurn(compactor, { role: "assistant", content: lastText })
  maybeCreateM0(compactor, prompt)
  history.push({ role: "user", content: prompt })
  if (lastText) history.push({ role: "assistant", content: lastText })
}
