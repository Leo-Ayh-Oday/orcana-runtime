import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { render, useInput, useStdout } from "ink"
import { agentLoop } from "../agent/loop"
import type { AgentOptions } from "../agent/loop-types"
import type { Runtime } from "../runtime/bootstrap"
import { type ClarificationReady } from "../agent/clarification"
import { TuiStore } from "./state/tui-store"
import { StreamEventAdapter } from "./state/event-adapter"
import {
  compactAssistantText,
  formatClarificationHistoryMarker,
  recommendedOptionIndex,
  synthesizeClarificationAnswer,
} from "./state/adapter-helpers"
import { AppShell, type ClarificationWizardState, type InputChromeState } from "./components/AppShell"
import type { ModelDialogOption, RuntimeDialogState, ThinkEffort } from "./components/AppShell"
import { ErrorBoundary } from "./components/ErrorBoundary"
import type { ScrollbackScrollState } from "./components/Scrollback"
import type { TaskProgressState } from "./components/PlanPanel"
import { renderMessageLines } from "./components/MessageItem"
import { cleanAgentError } from "./state/adapter-helpers"
import { dispatchTuiCommand } from "./commands/dispatcher"
import { resolveActiveContext } from "./input/types"
import { resolveKeyAction } from "./input/keymap"
import { cleanupTerminal, mouseEvents } from "./stdin-filter"
import { createStreamTrace, traceStartRound, traceDeltaChunk, traceFinalAccumulated, traceEndRound, traceSetStopReason, traceSetStreamError } from "./stream-trace"
import type { StreamTraceState } from "./stream-trace"
import type { ConfirmRequest } from "./confirm-stubs"
import type { RewindModalState } from "./components/RewindModal"

type ModelHistoryRole = "user" | "assistant"

// ── Phase 5: Modal state ──

interface TuiModalState {
  confirm: { request: ConfirmRequest; position: string } | null
  rewind: RewindModalState | null
  runtime: RuntimeDialogState | null
}

function emptyModalState(): TuiModalState {
  return { confirm: null, rewind: null, runtime: null }
}

/** 是否有任何 modal 激活 → composer disabled */
function isModalActive(modal: TuiModalState): boolean {
  return modal.confirm !== null || modal.rewind !== null || modal.runtime !== null
}

import { tuiTokens } from "./tokens"
import { ClockContext, REDUCED_MOTION, effectiveTick } from "./clock"
import { markTokenActivity, markToolActivity, resetStalledDetection } from "./pending-activity"

const TUI_STARTUP_MS = tuiTokens.motion.startupMs
const TUI_STREAM_FLUSH_MS = tuiTokens.motion.streamFlushMs
const TUI_FRAME_MS = tuiTokens.motion.frameMs
const TUI_SCROLL_STEP = tuiTokens.layout.scrollStep
const TUI_MOUSE_MODE = process.env.ORCANA_TUI_MOUSE === "1"

function TuiInputGuard() {
  // 保持 stdin 在 raw mode，并过滤鼠标/转义序列，防止泄漏到 TextArea。
  // Ink 的 useInput 没有 stopPropagation，所有 handler 都会收到所有输入，
  // 因此这里虽不能阻止 TextArea 收到鼠标序列，但可以在 mouse mode 关闭时
  // 确保不产生鼠标序列（useMouseWheelScroll 已移除）。
  useInput(() => {
    // Keep stdin in raw mode for the whole TUI so the host shell never echoes
    // typed characters below the Ink-rendered input box.
  })
  return null
}

function summarizeQueuedPromptForTranscript(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  const lines = normalized ? normalized.split("\n").length : 0
  const chars = normalized.length
  const firstLine = normalized
    .split("\n")
    .map(line => line.trim())
    .find(Boolean)
  const preview = firstLine ? firstLine.slice(0, 180) : ""
  if (chars <= 280 && lines <= 3) return preview || normalized
  const label = `[queued while agent is working: +${lines} lines, ${chars} chars]`
  return preview ? `${label}\npreview: ${preview}` : label
}

function traceRenderedAssistant(
  trace: StreamTraceState,
  store: TuiStore,
  finalTextLength: number,
): void {
  const state = store.getState()
  const assistant = [...state.messages].reverse().find(m => m.role === "assistant")
  const rawChars = assistant?.text.length ?? finalTextLength
  const rendered = assistant
    ? renderMessageLines(assistant, process.stdout.columns ?? 96, state.status)
    : []
  const displayChars = rendered.reduce((sum, line) => sum + line.text.length, 0)
  const viewportTrimmed = Boolean(
    assistant?.text.includes("live output trimmed")
    || rendered.some(line => line.text.includes("hidden above")),
  )
  traceEndRound(trace, rawChars, rendered.length > 0 ? displayChars : finalTextLength, viewportTrimmed)
}

function providerName(runtime: Runtime, providerId: string): string {
  return runtime.config.providers?.[providerId]?.displayName ?? providerId
}

function buildModelOptions(runtime: Runtime, currentModel: string, query = "", providerFilter?: string): ModelDialogOption[] {
  const needle = query.trim().toLowerCase()
  const catalogOptions = runtime.registry.allModels
    .filter(model => !providerFilter || model.providerId === providerFilter)
    .map(model => ({
      providerId: model.providerId,
      providerName: providerName(runtime, model.providerId),
      modelId: model.id,
      modelName: model.displayName,
      configured: runtime.isProviderConfigured(model.providerId),
      current: model.id === currentModel,
      tier: model.pricingTier,
      thinking: model.thinking.supported,
      contextWindow: model.contextWindow,
    }))
    .filter(option => {
      if (!needle) return true
      return (
        option.modelId.toLowerCase().includes(needle)
        || option.modelName.toLowerCase().includes(needle)
        || option.providerId.toLowerCase().includes(needle)
        || option.providerName.toLowerCase().includes(needle)
      )
    })
    .sort((a, b) => Number(b.current) - Number(a.current)
      || Number(b.configured) - Number(a.configured)
      || a.providerName.localeCompare(b.providerName)
      || a.modelName.localeCompare(b.modelName))
  const showCustom = !providerFilter || providerFilter === "custom"
  const customOption: ModelDialogOption[] = showCustom ? [{
    providerId: "custom",
    providerName: "OpenAI-compatible",
    modelId: "__custom__",
    modelName: "自定义模型",
    configured: runtime.isProviderConfigured("custom"),
    current: false,
    tier: "custom",
    thinking: false,
    contextWindow: 128_000,
    custom: true,
  }] : []
  return [...catalogOptions, ...customOption]
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0
  if (index < 0) return length - 1
  if (index >= length) return 0
  return index
}

function effortLabel(value: ThinkEffort): string {
  if (value === "auto") return "自动"
  if (value === "high") return "高"
  return "最大"
}

function modelSeedFromQuery(query: string): string {
  const value = query.trim()
  if (!value || value === "/" || value.toLowerCase() === "custom" || value === "自定义") return ""
  return value
}

function normalizeBaseUrl(raw: string, fallback?: string): string | undefined {
  const value = raw.trim() || fallback?.trim() || ""
  return value || undefined
}

function isValidBaseUrl(value: string | undefined): boolean {
  return !value || /^https?:\/\//i.test(value)
}

function useAgentStream(
  runtime: Runtime,
  prompt: string | undefined,
  controls: {
    openModels: (provider?: string) => void
    openEffort: () => void
  },
) {
  const storeRef = useRef<TuiStore | null>(null)
  if (storeRef.current === null) {
    storeRef.current = new TuiStore()
    const currentModel = runtime.modelRouter.getSessionModel()
    const provider = runtime.registry.resolveModel(currentModel)?.providerId
    storeRef.current.dispatch({
      type: "session.started",
      sessionId: runtime.sessionId,
      repoRoot: process.cwd(),
      provider,
      model: currentModel,
    })
    // If there's an initial prompt, mark as starting; otherwise ready
    if (prompt?.trim()) {
      storeRef.current.dispatch({ type: "ui.status", text: "starting..." })
      storeRef.current.dispatch({ type: "ui.done", done: false })
    }
  }
  const store = storeRef.current

  const adapterRef = useRef<StreamEventAdapter | null>(null)
  if (adapterRef.current === null) {
    adapterRef.current = new StreamEventAdapter()
  }
  const adapter = adapterRef.current

  // Phase 2: Stream trace (DEEPSEEK_TUI_TRACE_STREAM=1)
  const traceRef = useRef<StreamTraceState>(createStreamTrace())

  // Subscribe to TuiStore — re-renders on every dispatch/dispatchMany
  const state = useSyncExternalStore(
    (cb: () => void) => store.subscribe(cb),
    () => store.getState(),
    () => store.getState(),
  )

  const historyRef = useRef<Array<{ role: ModelHistoryRole; content: string }>>([])
  const runningRef = useRef(false)
  const queuedPromptsRef = useRef<string[]>([])
  const runAgentRef = useRef<(prompt: string) => void>(() => {})
  const [clarification, setClarification] = useState<ClarificationWizardState | null>(null)
  const initialEffort = runtime.config.runtime?.thinkingEffort
  const [thinkEffort, setThinkEffortState] = useState<ThinkEffort>(
    initialEffort === "high" || initialEffort === "max" ? initialEffort : "auto",
  )

  const addSystemMessage = useCallback((content: string) => {
    store.dispatch({ type: "assistant.final", text: content })
    store.dispatch({ type: "ui.done", done: true })
    store.dispatch({ type: "ui.status", text: "ready" })
    store.dispatch({ type: "ui.error_line", text: "" })
  }, [store])

  const runAgent = useCallback((p: string) => {
    runningRef.current = true
    resetStalledDetection() // Phase 5: reset stalled watchdog for new run
    store.dispatch({ type: "ui.queue_count", count: queuedPromptsRef.current.length })
    const historySnapshot = historyRef.current.slice()

    let cancelled = false
    let textBuf = ""
    let assistantText = ""
    let lastFlush = 0
    const finishRun = () => {
      const nextPrompt = queuedPromptsRef.current.shift()
      store.dispatch({ type: "ui.queue_count", count: queuedPromptsRef.current.length })
      if (nextPrompt) {
        // 保持 runningRef = true，防止 setTimeout(0) 窗口期内新消息绕过队列。
        // 之前先设 false 再 setTimeout，存在竞态：用户在窗口期提交的消息
        // 会直接调 runAgent 而非排队，导致两个 agent 并发。
        setTimeout(() => runAgentRef.current(nextPrompt), 0)
      } else {
        runningRef.current = false
      }
    }

    // Bug 修复：user.message 必须在 buildAgentOptions 之前 dispatch，
    // 确保 user message 总是显示（即使 buildAgentOptions 抛错）。
    // 之前顺序：buildAgentOptions → user.message，若前者抛错则用户消息不可见。
    store.dispatch({ type: "user.message", text: p })

    // 构建 AgentOptions，若失败则显示错误并结束本轮（不启动 async agentLoop）
    let opts: AgentOptions
    try {
      opts = runtime.buildAgentOptions({
        model: runtime.modelRouter.selectForPurpose("agent_main"),
        tools: runtime.tools,
        maxRounds: 30,
        thinkEffort: thinkEffort === "auto" ? undefined : thinkEffort,
        conversationHistory: historySnapshot,
        gateTelemetryFile: ".wolf/gate-telemetry.json",
        runTrace: runtime.startRunTrace(p),
      })
    } catch (err) {
      const message = cleanAgentError(err instanceof Error ? err.message : String(err))
      store.dispatch({ type: "ui.error_line", text: message })
      store.dispatch({ type: "assistant.final", text: `Failed to start agent: ${message}` })
      store.dispatch({ type: "ui.done", done: true })
      store.dispatch({ type: "ui.status", text: "error" })
      finishRun()
      return () => { cancelled = true }
    }

    const flush = () => {
      if (!textBuf) return
      const chunk = textBuf
      textBuf = ""
      lastFlush = Date.now()
      traceDeltaChunk(traceRef.current, chunk)
      store.dispatch({ type: "assistant.delta", text: chunk })
    }

    // Phase 2: trace round start
    traceStartRound(traceRef.current, state.round + 1)

    ;(async () => {
      for await (const ev of agentLoop(p, opts)) {
        if (cancelled) return

        // clarification_ready needs local side effects (history, wizard state)
        if (ev.type === "clarification_ready") {
          const d = ev.data as ClarificationReady
          flush()
          // Dispatch clarification.ready to TuiStore (sets status, done, pending message)
          store.dispatchMany(adapter.adapt(ev))
          // Set local wizard state for interactive navigation
          setClarification({
            originalPrompt: d.originalPrompt,
            questions: d.questions,
            index: 0,
            selected: recommendedOptionIndex(d.questions[0]),
            answers: [],
            extraPrompt: d.extraPrompt,
            rawText: d.rawText,
          })
          assistantText = formatClarificationHistoryMarker(d)
          historyRef.current = [
            ...historySnapshot,
            { role: "user", content: p },
            { role: "assistant", content: formatClarificationHistoryMarker(d) },
          ]
          runningRef.current = false
          return
        }

        // Text buffering: preserve 120ms flush optimization
        if (ev.type === "text" && typeof ev.data === "string") {
          assistantText += ev.data
          textBuf += ev.data
          markTokenActivity() // Phase 5: stalled detection
          if (Date.now() - lastFlush > TUI_STREAM_FLUSH_MS) flush()
          continue
        }

        // All other events: translate via adapter and batch-dispatch
        const tuiEvents = adapter.adapt(ev)
        if (tuiEvents.length > 0) {
          // Phase 5: stalled detection — tool events keep the watchdog alive
          if (tuiEvents.some(e => e.type.startsWith("tool."))) {
            markToolActivity()
          }
          store.dispatchMany(tuiEvents)
        }

        // Phase 0: capture provider stop_reason + stream error in TUI trace
        if (ev.type === "status" && typeof ev.data === "string") {
          const stopMatch = ev.data.match(/^provider-stop:\s*(.+)/)
          if (stopMatch) traceSetStopReason(traceRef.current, stopMatch[1]!)
        }
        if (ev.type === "error" && typeof ev.data === "string") {
          traceSetStreamError(traceRef.current, ev.data)
        }
      }

      // Agent loop completed normally
      flush()
      // Phase 2: trace final accumulated text
      const finalText = assistantText.trim()
      traceFinalAccumulated(traceRef.current, finalText.length, false)
      historyRef.current = [
        ...historySnapshot,
        { role: "user", content: p },
        ...(assistantText.trim() ? [{ role: "assistant" as const, content: compactAssistantText(assistantText) }] : []),
      ]
      // assistant.final("") marks pending message non-pending, preserves accumulated text
      store.dispatch({ type: "assistant.final", text: "" })
      traceRenderedAssistant(traceRef.current, store, finalText.length)
      store.dispatch({ type: "ui.done", done: true })
      store.dispatch({ type: "ui.status", text: "done" })
      finishRun()
    })().catch(error => {
      const message = cleanAgentError(error instanceof Error ? error.message : String(error))
      flush()
      traceFinalAccumulated(traceRef.current, message.length, true)
      store.dispatch({ type: "ui.error_line", text: message })
      store.dispatch({ type: "ui.done", done: true })
      store.dispatch({ type: "assistant.final", text: message })
      traceRenderedAssistant(traceRef.current, store, message.length)
      finishRun()
    })

    return () => { cancelled = true }
  }, [runtime, store, adapter, thinkEffort])

  const setThinkEffort = useCallback((value: ThinkEffort) => {
    setThinkEffortState(value)
    runtime.configureThinkingEffort(value)
    store.dispatch({
      type: "ui.event_message",
      kind: "activity",
      text: `推理深度已切换为 ${value}（${effortLabel(value)}），已保存到 Orcana 全局配置。`,
      minIntervalMs: 0,
    })
  }, [runtime, store])

  const answerClarification = useCallback((answer: { question: string; key: string; label: string }) => {
    setClarification(current => {
      if (!current) return current
      const answers = [...current.answers, answer]
      const nextIndex = current.index + 1
      if (nextIndex < current.questions.length) {
        const nextQuestion = current.questions[nextIndex]
        return {
          ...current,
          answers,
          index: nextIndex,
          selected: recommendedOptionIndex(nextQuestion),
        }
      }

      const complete: ClarificationWizardState = { ...current, answers, index: nextIndex }
      setTimeout(() => runAgent(synthesizeClarificationAnswer(complete)), 0)
      return null
    })
  }, [runAgent])

  const moveClarificationSelection = useCallback((delta: number) => {
    setClarification(current => {
      if (!current) return current
      const options = current.questions[current.index]?.options ?? []
      if (options.length === 0) return current
      return {
        ...current,
        selected: (current.selected + delta + options.length) % options.length,
      }
    })
  }, [])

  const cancelClarification = useCallback(() => {
    setClarification(null)
    addSystemMessage("Clarification cancelled. Add more detail in the input box when you are ready.")
  }, [addSystemMessage])

  useEffect(() => {
    runAgentRef.current = runAgent
  }, [runAgent])

  const submit = useCallback((newPrompt: string) => {
    const commandResult = dispatchTuiCommand(newPrompt, {
      runtime,
      store,
      adapter,
      historyRef,
      setClarification,
      addSystemMessage,
      isRunning: () => runningRef.current,
      exit: () => {
        cleanupTerminal()
        runtime.dispose()
        process.exit(0)
      },
      openModels: controls.openModels,
      openEffort: controls.openEffort,
      setThinkEffort,
    })
    if (commandResult === "handled") {
      return
    }

    // ── agent 忙碌时排队用户消息 ──
    if (runningRef.current) {
      queuedPromptsRef.current.push(newPrompt)
      const queuedPosition = queuedPromptsRef.current.length
      store.dispatch({ type: "ui.queue_count", count: queuedPromptsRef.current.length })
      store.dispatch({
        type: "ui.event_message",
        kind: "task",
        text: `queued user message #${queuedPosition}\n${summarizeQueuedPromptForTranscript(newPrompt)}`,
        minIntervalMs: 0,
      })
      return
    }

    runAgent(newPrompt)
  }, [addSystemMessage, runAgent, store, adapter, runtime, controls.openModels, controls.openEffort, setThinkEffort])

  useEffect(() => {
    if (!prompt?.trim()) return
    return runAgent(prompt)
  }, [prompt, runAgent])

  return { state, submit, clarification, answerClarification, moveClarificationSelection, cancelClarification, store, thinkEffort, setThinkEffort }
}

export function ChatApp({ prompt, runtime }: { prompt?: string; runtime: Runtime }) {
  const { stdout } = useStdout()
  const rows = Math.max(24, stdout.rows ?? 32)
  const cols = stdout.columns ?? 96
  const [modal, setModal] = useState<TuiModalState>(emptyModalState)
  const thinkEffortRef = useRef<ThinkEffort>("auto")
  const openModels = useCallback((provider?: string) => {
    const currentModel = runtime.modelRouter.getSessionModel()
    const options = buildModelOptions(runtime, currentModel, "", provider)
    setModal(m => ({
      ...m,
      runtime: {
        type: "models",
        phase: "list",
        query: "",
        selected: 0,
        options,
        providerFilter: provider,
        error: provider && options.length === 0 ? `没有找到 provider：${provider}` : undefined,
      },
    }))
  }, [runtime])
  const openEffort = useCallback(() => {
    const options: ThinkEffort[] = ["auto", "high", "max"]
    const selected = Math.max(0, options.indexOf(thinkEffortRef.current))
    setModal(m => ({
      ...m,
      runtime: {
        type: "effort",
        selected,
        current: thinkEffortRef.current,
      },
    }))
  }, [])
  const { state, submit, clarification, answerClarification, moveClarificationSelection, cancelClarification, store, thinkEffort, setThinkEffort } = useAgentStream(runtime, prompt, { openModels, openEffort })
  thinkEffortRef.current = thinkEffort
  const [tick, setTick] = useState(0)
  const [scrollOffset, setScrollOffset] = useState(0)
  const [scrollState, setScrollState] = useState<ScrollbackScrollState>({ maxOffset: 0, normalizedOffset: 0, hiddenAbove: false, hiddenBelow: false })
  const [autoFollow, setAutoFollow] = useState(true)
  const [inputChrome, setInputChrome] = useState<InputChromeState>({ commandOpen: false, pasteCount: 0, textRows: 1 })
  const [showStartup, setShowStartup] = useState(process.env.DEEPSEEK_TUI_SPLASH !== "off")
  // TuiState.task 是 unknown（reducer 不感知 TaskProgressState 形状），这里做一次类型收窄
  const task = state.task as TaskProgressState | undefined
  const isWorking = !state.done && !state.errorLine

  // 布局计算（与 AppShell computeAppShellLayout 保持一致）
  // OrcanaComposer 多行布局：TextArea(textRows 行) + 状态行(1行) + 可能的粘贴指示(1行)
  // 命令面板打开时占 5 行（3 条候选 + 标题 + 空行）
  // FooterHints 占 1 行，footerHeight 需额外 +1
  const question = clarification?.questions[clarification.index]
  const clarificationRows = clarification ? Math.min(10, 4 + (question?.options.length ?? 0)) : 0
  const taskRows = task ? (task.phase === "planning" ? 3 : Math.min(5, 1 + Math.min(3, task.steps.length))) : 0
  const panelRows = clarificationRows || taskRows
  const textRows = inputChrome.textRows > 0 ? inputChrome.textRows : 1
  const inputRows = inputChrome.commandOpen
    ? 5
    : textRows + 1 + (inputChrome.pasteCount > 0 ? 1 : 0)
  const footerHeight = Math.max(2, Math.min(rows - 8, panelRows + inputRows + 1))
  const bodyHeight = Math.max(10, rows - footerHeight - 3)

  const scrollUp = useCallback((amount = TUI_SCROLL_STEP) => {
    setAutoFollow(false)
    setScrollOffset(offset => offset + amount)
  }, [])

  const scrollDown = useCallback((amount = TUI_SCROLL_STEP) => {
    setScrollOffset(offset => Math.max(0, offset - amount))
  }, [])

  useEffect(() => {
    if (scrollOffset === 0) setAutoFollow(true)
  }, [scrollOffset])

  const submitFromInput = useCallback((value: string) => {
    setAutoFollow(true)
    setScrollOffset(0)
    submit(value)
  }, [submit])

  useEffect(() => {
    stdout.write("\x1B[?25l")
    return () => {
      stdout.write("\x1B[?25h")
    }
  }, [stdout])

  useEffect(() => {
    if (REDUCED_MOTION) return
    const animated = showStartup || isWorking || Boolean(clarification) || task?.phase === "planning"
    if (!animated) return
    const timer = setInterval(() => setTick(n => n + 1), isWorking ? TUI_FRAME_MS : Math.max(TUI_FRAME_MS, 500))
    return () => clearInterval(timer)
  }, [clarification, isWorking, showStartup, task?.phase])

  useEffect(() => {
    if (!showStartup) return
    const timer = setTimeout(() => setShowStartup(false), TUI_STARTUP_MS)
    return () => clearTimeout(timer)
  }, [showStartup])

  // Phase 5: 键位上下文分发 — 扩大到 Confirm/RewindList/RewindConfirm
  // PR-5: 新增 CommandShelf context — 命令菜单打开时不让 Scrollback 抢键
  const activeKeyContext = resolveActiveContext({
    clarificationActive: !!clarification,
    confirmActive: modal.confirm !== null,
    rewindListActive: modal.rewind?.phase === "list",
    rewindConfirmActive: modal.rewind?.phase === "confirm",
    commandOpen: inputChrome.commandOpen,
    runtimeDialogActive: modal.runtime !== null,
  })

  useInput((_input, key) => {
    if (showStartup) return
    if (modal.runtime) {
      const runtimeDialog = modal.runtime
      if (key.escape) {
        setModal(m => ({ ...m, runtime: null }))
        return
      }
      if (runtimeDialog.type === "effort") {
        const options: ThinkEffort[] = ["auto", "high", "max"]
        if (key.upArrow) {
          setModal(m => m.runtime?.type === "effort" ? { ...m, runtime: { ...m.runtime, selected: clampIndex(m.runtime.selected - 1, options.length) } } : m)
          return
        }
        if (key.downArrow) {
          setModal(m => m.runtime?.type === "effort" ? { ...m, runtime: { ...m.runtime, selected: clampIndex(m.runtime.selected + 1, options.length) } } : m)
          return
        }
        if (key.return) {
          const value = options[runtimeDialog.selected] ?? "auto"
          setThinkEffort(value)
          setModal(m => ({ ...m, runtime: null }))
          return
        }
        return
      }

      if (runtimeDialog.phase === "list") {
        if (key.upArrow) {
          setModal(m => m.runtime?.type === "models" && m.runtime.phase === "list"
            ? { ...m, runtime: { ...m.runtime, selected: clampIndex(m.runtime.selected - 1, m.runtime.options.length) } }
            : m)
          return
        }
        if (key.downArrow || key.tab) {
          setModal(m => m.runtime?.type === "models" && m.runtime.phase === "list"
            ? { ...m, runtime: { ...m.runtime, selected: clampIndex(m.runtime.selected + 1, m.runtime.options.length) } }
            : m)
          return
        }
        if (key.backspace || key.delete) {
          setModal(m => {
            if (m.runtime?.type !== "models" || m.runtime.phase !== "list") return m
            const query = m.runtime.query.slice(0, -1)
            return {
              ...m,
              runtime: {
                ...m.runtime,
                query,
                selected: 0,
                options: buildModelOptions(runtime, state.modelName, query, m.runtime.providerFilter),
              },
            }
          })
          return
        }
        if (key.return) {
          const selected = runtimeDialog.options[runtimeDialog.selected]
          if (!selected) return
          if (selected.custom) {
            setModal(m => ({
              ...m,
              runtime: {
                type: "models",
                phase: "custom",
                providerId: selected.providerId,
                providerName: selected.providerName,
                modelValue: modelSeedFromQuery(runtimeDialog.query),
              },
            }))
            return
          }
          if (!selected.configured) {
            setModal(m => ({
              ...m,
              runtime: {
                type: "models",
                phase: "key",
                providerId: selected.providerId,
                providerName: selected.providerName,
                modelId: selected.modelId,
                modelName: selected.modelName,
                keyValue: "",
              },
            }))
            return
          }
          void runtime.configureModel({ providerId: selected.providerId, modelId: selected.modelId })
            .then(() => {
              store.dispatch({ type: "ui.model_name", name: selected.modelId })
              store.dispatch({ type: "session.started", sessionId: runtime.sessionId, repoRoot: process.cwd(), provider: selected.providerId, model: selected.modelId })
              store.dispatch({ type: "ui.error_line", text: "" })
              store.dispatch({ type: "ui.event_message", kind: "activity", text: `模型已切换：${selected.providerName} / ${selected.modelName}`, minIntervalMs: 0 })
              setModal(m => ({ ...m, runtime: null }))
            })
            .catch(err => {
              const message = cleanAgentError(err instanceof Error ? err.message : String(err))
              setModal(m => m.runtime?.type === "models" ? { ...m, runtime: { ...m.runtime, error: message } } : m)
            })
          return
        }
        if (_input && !key.ctrl && !key.meta && !key.return && !key.escape) {
          const inputText = _input.replace(/\r?\n/g, "")
          if (!inputText) return
          setModal(m => {
            if (m.runtime?.type !== "models" || m.runtime.phase !== "list") return m
            const query = `${m.runtime.query}${inputText}`
            return {
              ...m,
              runtime: {
                ...m.runtime,
                query,
                selected: 0,
                options: buildModelOptions(runtime, state.modelName, query, m.runtime.providerFilter),
                error: undefined,
              },
            }
          })
          return
        }
        return
      }

      if (runtimeDialog.phase === "custom") {
        if (key.backspace || key.delete) {
          setModal(m => m.runtime?.type === "models" && m.runtime.phase === "custom"
            ? { ...m, runtime: { ...m.runtime, modelValue: m.runtime.modelValue.slice(0, -1), error: undefined } }
            : m)
          return
        }
        if (key.return) {
          const modelId = runtimeDialog.modelValue.trim()
          if (!modelId) {
            setModal(m => m.runtime?.type === "models" && m.runtime.phase === "custom"
              ? { ...m, runtime: { ...m.runtime, error: "请输入模型 ID 后再回车。" } }
              : m)
            return
          }
          setModal(m => ({
            ...m,
            runtime: {
              type: "models",
              phase: "url",
              providerId: runtimeDialog.providerId,
              providerName: runtimeDialog.providerName,
              modelId,
              modelName: modelId,
              baseUrlValue: "",
            },
          }))
          return
        }
        if (_input && !key.ctrl && !key.meta && !key.return && !key.escape) {
          const inputText = _input.replace(/\r?\n/g, "")
          if (!inputText) return
          setModal(m => m.runtime?.type === "models" && m.runtime.phase === "custom"
            ? { ...m, runtime: { ...m.runtime, modelValue: `${m.runtime.modelValue}${inputText}`, error: undefined } }
            : m)
          return
        }
        return
      }

      if (runtimeDialog.phase === "url") {
        if (key.backspace || key.delete) {
          setModal(m => m.runtime?.type === "models" && m.runtime.phase === "url"
            ? { ...m, runtime: { ...m.runtime, baseUrlValue: m.runtime.baseUrlValue.slice(0, -1), error: undefined } }
            : m)
          return
        }
        if (key.return) {
          const baseUrl = normalizeBaseUrl(runtimeDialog.baseUrlValue, runtimeDialog.defaultBaseUrl)
          if (!baseUrl) {
            setModal(m => m.runtime?.type === "models" && m.runtime.phase === "url"
              ? { ...m, runtime: { ...m.runtime, error: "请输入 API URL，例如 https://api.example.com/v1。" } }
              : m)
            return
          }
          if (!isValidBaseUrl(baseUrl)) {
            setModal(m => m.runtime?.type === "models" && m.runtime.phase === "url"
              ? { ...m, runtime: { ...m.runtime, error: "URL 必须以 http:// 或 https:// 开头。" } }
              : m)
            return
          }
          if (runtimeDialog.providerId === "custom" || !runtime.isProviderConfigured(runtimeDialog.providerId)) {
            setModal(m => ({
              ...m,
              runtime: {
                type: "models",
                phase: "key",
                providerId: runtimeDialog.providerId,
                providerName: runtimeDialog.providerName,
                modelId: runtimeDialog.modelId,
                modelName: runtimeDialog.modelName,
                keyValue: "",
                custom: true,
                baseUrl,
              },
            }))
            return
          }
          setModal(m => m.runtime?.type === "models" && m.runtime.phase === "url"
            ? { ...m, runtime: { ...m.runtime, error: "正在保存自定义模型..." } }
            : m)
          void runtime.configureModel({
            providerId: runtimeDialog.providerId,
            modelId: runtimeDialog.modelId,
            custom: true,
            displayName: runtimeDialog.modelName,
            baseUrl,
          })
            .then(() => {
              store.dispatch({ type: "ui.model_name", name: runtimeDialog.modelId })
              store.dispatch({ type: "session.started", sessionId: runtime.sessionId, repoRoot: process.cwd(), provider: runtimeDialog.providerId, model: runtimeDialog.modelId })
              store.dispatch({ type: "ui.error_line", text: "" })
              store.dispatch({ type: "ui.event_message", kind: "activity", text: `已保存自定义模型：${runtimeDialog.providerName} / ${runtimeDialog.modelName}`, minIntervalMs: 0 })
              setModal(m => ({ ...m, runtime: null }))
            })
            .catch(err => {
              const message = cleanAgentError(err instanceof Error ? err.message : String(err))
              setModal(m => m.runtime?.type === "models" && m.runtime.phase === "url"
                ? { ...m, runtime: { ...m.runtime, error: message } }
                : m)
            })
          return
        }
        if (_input && !key.ctrl && !key.meta && !key.return && !key.escape) {
          const inputText = _input.replace(/\r?\n/g, "")
          if (!inputText) return
          setModal(m => m.runtime?.type === "models" && m.runtime.phase === "url"
            ? { ...m, runtime: { ...m.runtime, baseUrlValue: `${m.runtime.baseUrlValue}${inputText}`, error: undefined } }
            : m)
          return
        }
        return
      }

      if (runtimeDialog.phase === "key") {
        if (key.backspace || key.delete) {
          setModal(m => m.runtime?.type === "models" && m.runtime.phase === "key"
            ? { ...m, runtime: { ...m.runtime, keyValue: m.runtime.keyValue.slice(0, -1), error: undefined } }
            : m)
          return
        }
        if (key.return) {
          const apiKey = runtimeDialog.keyValue.trim()
          if (!apiKey) {
            setModal(m => m.runtime?.type === "models" && m.runtime.phase === "key"
              ? { ...m, runtime: { ...m.runtime, error: "请输入 API key 后再回车。" } }
              : m)
            return
          }
          setModal(m => m.runtime?.type === "models" && m.runtime.phase === "key"
            ? { ...m, runtime: { ...m.runtime, error: "正在保存 key 并连接模型..." } }
            : m)
          void runtime.configureModel({
            providerId: runtimeDialog.providerId,
            modelId: runtimeDialog.modelId,
            apiKey,
            custom: runtimeDialog.custom,
            displayName: runtimeDialog.modelName,
            baseUrl: runtimeDialog.baseUrl,
          })
            .then(() => {
              store.dispatch({ type: "ui.model_name", name: runtimeDialog.modelId })
              store.dispatch({ type: "session.started", sessionId: runtime.sessionId, repoRoot: process.cwd(), provider: runtimeDialog.providerId, model: runtimeDialog.modelId })
              store.dispatch({ type: "ui.error_line", text: "" })
              store.dispatch({ type: "ui.event_message", kind: "activity", text: `已保存 key，并切换到 ${runtimeDialog.providerName} / ${runtimeDialog.modelName}`, minIntervalMs: 0 })
              setModal(m => ({ ...m, runtime: null }))
            })
            .catch(err => {
              const message = cleanAgentError(err instanceof Error ? err.message : String(err))
              setModal(m => m.runtime?.type === "models" && m.runtime.phase === "key"
                ? { ...m, runtime: { ...m.runtime, error: message } }
                : m)
            })
          return
        }
        if (_input && !key.ctrl && !key.meta && !key.return && !key.escape) {
          const inputText = _input.replace(/\r?\n/g, "")
          if (!inputText) return
          setModal(m => m.runtime?.type === "models" && m.runtime.phase === "key"
            ? { ...m, runtime: { ...m.runtime, keyValue: `${m.runtime.keyValue}${inputText}`, error: undefined } }
            : m)
          return
        }
      }
      return
    }
    const action = resolveKeyAction(_input, key, {
      context: activeKeyContext,
      bodyHeight,
      scrollStep: TUI_SCROLL_STEP,
    })
    if (!action) return // pass through to composer

    switch (action.type) {
      // ── Confirm modal ──
      case "confirm.approve":
        store.dispatch({ type: "ui.event_message", kind: "activity", text: `✓ confirmed ${modal.confirm?.request.toolName ?? ""}` })
        setModal(emptyModalState())
        break
      case "confirm.deny":
        store.dispatch({ type: "ui.event_message", kind: "error", text: `✗ denied ${modal.confirm?.request.toolName ?? ""}` })
        setModal(emptyModalState())
        break
      case "confirm.denyAll":
        store.dispatch({ type: "ui.event_message", kind: "error", text: "✗ denied all pending confirmations" })
        setModal(emptyModalState())
        break
      case "confirm.dismiss":
        setModal(emptyModalState())
        break
      // ── Rewind modal ──
      case "rewind.up":
        setModal(m => {
          if (!m.rewind || m.rewind.phase !== "list") return m
          const s = m.rewind.state
          return { ...m, rewind: { ...m.rewind, state: { ...s, selectedIndex: Math.max(0, s.selectedIndex - 1) } } }
        })
        break
      case "rewind.down":
        setModal(m => {
          if (!m.rewind || m.rewind.phase !== "list") return m
          const s = m.rewind.state
          return { ...m, rewind: { ...m.rewind, state: { ...s, selectedIndex: Math.min(s.entries.length - 1, s.selectedIndex + 1) } } }
        })
        break
      case "rewind.select":
        setModal(m => {
          if (!m.rewind) return m
          if (m.rewind.phase === "list") {
            // Move to confirm phase
            const entry = m.rewind.state.entries[m.rewind.state.selectedIndex]
            return {
              ...m,
              rewind: {
                phase: "confirm" as const,
                state: {
                  visible: true,
                  targetRound: entry?.round ?? 0,
                  mode: "code" as const,
                  previewFiles: [],
                },
              },
            }
          }
          if (m.rewind.phase === "confirm") {
            // Execute rewind — move to progress (stub)
            store.dispatch({ type: "ui.event_message", kind: "activity", text: `rewind to round ${m.rewind.state.targetRound} (stub — backend not yet wired)` })
            return emptyModalState()
          }
          return m
        })
        break
      case "rewind.cancel":
        setModal(emptyModalState())
        break
      // ── Clarification ──
      case "clarification.up":
        moveClarificationSelection(-1)
        break
      case "clarification.down":
        moveClarificationSelection(1)
        break
      case "clarification.select": {
        const q = clarification?.questions[clarification.index]
        if (!q) break
        const opt = q.options[clarification.selected]
        if (opt) answerClarification({ question: q.title, key: opt.key, label: opt.label })
        break
      }
      case "clarification.cancel":
        cancelClarification()
        break
      // ── Scrollback ──
      case "scroll.up":
        scrollUp(action.amount)
        break
      case "scroll.down":
        scrollDown(action.amount)
        break
      case "scroll.pageUp":
        scrollUp(action.amount)
        break
      case "scroll.pageDown":
        scrollDown(action.amount)
        break
    }
  }, { isActive: !showStartup })

  useEffect(() => {
    if (autoFollow) setScrollOffset(0)
  }, [autoFollow, state.messages.length])

  useEffect(() => {
    setScrollOffset(offset => Math.min(offset, scrollState.maxOffset))
  }, [scrollState.maxOffset])

  // 鼠标滚轮滚动：默认关闭 mouse reporting，让终端原生拖选/Ctrl+C 复制可用。
  // 只有 ORCANA_TUI_MOUSE=1 时，stdin-filter 才会收到终端鼠标序列并分发 scroll。
  useEffect(() => {
    if (!TUI_MOUSE_MODE) return
    const handler = (direction: number, isCtrl: boolean) => {
      const amount = isCtrl ? 1 : 3
      if (direction < 0) scrollUp(amount)
      else scrollDown(amount)
    }
    mouseEvents.on("scroll", handler)
    return () => {
      mouseEvents.off("scroll", handler)
    }
  }, [scrollUp, scrollDown])

  return (
    <ClockContext.Provider value={effectiveTick(tick)}>
      <TuiInputGuard />
      <AppShell
        state={state}
        runtime={runtime}
        prompt={prompt}
        scrollOffset={scrollOffset}
        scrollState={scrollState}
        onScrollState={setScrollState}
        showStartup={showStartup}
        clarification={clarification}
        inputChrome={inputChrome}
        submit={submitFromInput}
        answerClarification={answerClarification}
        moveClarificationSelection={moveClarificationSelection}
        cancelClarification={cancelClarification}
        scrollUp={scrollUp}
        scrollDown={scrollDown}
        setInputChrome={setInputChrome}
        confirmModal={modal.confirm}
        rewindModal={modal.rewind}
        runtimeDialog={modal.runtime}
        thinkingEffort={thinkEffort}
      />
    </ClockContext.Provider>
  )
}

export async function startInkTUI(prompt?: string) {
  // PR-6: API key 可来自 env、auth store 或 config，由 createRuntime 统一解析。
  // 这里不再硬编码检查 DEEPSEEK_API_KEY，让 bootstrap 抛出更有用的错误信息。
  // Lazy-import to avoid circular dependency at module load time
  const { createRuntime } = await import("../runtime/bootstrap")
  const runtime = await createRuntime({
    projectRoot: process.cwd(),
    enableMCP: true,
    enableLSP: true,
    allowMissingProviderAuth: true,
    useEnvAuth: false,
    configOptions: { applyEnv: false },
  })

  // Bug 修复：安装 stdin 过滤器拦截鼠标序列。
  // react-ink-textarea 的 useKeyboardInput fallback 分支会插入任何非空 input，
  // 包括 SGR 鼠标序列（\x1B[<0;40;10M），导致滚轮在输入框产生乱码。
  // 必须在 render 之前安装，确保过滤后的数据才到达 Ink。
  const { installStdinFilter, enableMouseMode, disableMouseMode, enableAlternateScrollMode } = await import("./stdin-filter")
  installStdinFilter()
  disableMouseMode()
  if (TUI_MOUSE_MODE) {
    enableMouseMode()
  } else {
    enableAlternateScrollMode()
  }

  // 设置终端标题（生产级 TUI 标配）
  const projectDir = process.cwd().split(/[/\\]/).pop() ?? "deepseek-code"
  process.stdout.write(`\x1B]0;Orcana — ${projectDir}\x07`)

  // SIGINT/Ctrl+C 优雅退出：恢复终端状态后退出。
  // process.exit 不触发 finally 块，必须手动清理。
  const sigintHandler = () => {
    cleanupTerminal()
    runtime.dispose()
    process.exit(130)
  }
  process.on("SIGINT", sigintHandler)

  const { waitUntilExit } = render(
    <ErrorBoundary>
      <ChatApp prompt={prompt} runtime={runtime} />
    </ErrorBoundary>,
  )
  try {
    return await waitUntilExit()
  } finally {
    process.off("SIGINT", sigintHandler)
    cleanupTerminal()
    runtime.dispose()
  }
}
