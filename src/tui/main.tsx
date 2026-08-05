import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react"
import { render, useInput, useStdout } from "ink"
import {
  LEGACY_CONVERSATION_HISTORY,
  LEGACY_RUN_TRACE,
  LEGACY_THINK_EFFORT,
} from "../harness/runtime/legacy-loop-adapter"
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
import { AppShell, type ClarificationWizardState, type InputChromeState, useAppLayout } from "./components/AppShell"
import type { ThinkEffort } from "./components/AppShell"
import { ErrorBoundary } from "./components/ErrorBoundary"
import { adjustScrollOffsetForGrowth, type ScrollbackScrollState } from "./components/Scrollback"
import { renderMessageLines } from "./components/MessageItem"
import { cleanAgentError } from "./state/adapter-helpers"
import { dispatchTuiCommand } from "./commands/dispatcher"
import { resolveActiveContext } from "./input/types"
import { cleanupTerminal, mouseEvents, resolveMouseModeEnabled } from "./stdin-filter"
import { createStreamTrace, traceStartRound, traceDeltaChunk, traceFinalAccumulated, traceEndRound, traceSetStopReason, traceSetStreamError } from "./stream-trace"
import type { StreamTraceState } from "./stream-trace"
import { useOverlayController } from "./app/useOverlayController"
import { matchAction } from "./presentation/actions"
import { dispatchAction, type ActionExecutionContext } from "./presentation/dispatcher"
import { deriveTranscriptBlocks } from "./presentation/derive-blocks"
import { reduceTranscriptViewState, createInitialTranscriptViewState } from "./presentation/block-view-state"
import type { ActionId } from "./presentation/actions"
import type { ModelDialogOption } from "./overlays"
import { installProfileReporter } from "./render-metrics"

type ModelHistoryRole = "user" | "assistant"

import { tuiTokens } from "./tokens"
import { markTokenActivity, markToolActivity, resetStalledDetection } from "./pending-activity"

const TUI_STARTUP_MS = tuiTokens.motion.startupMs
const TUI_STREAM_FLUSH_MS = tuiTokens.motion.streamFlushMs
const TUI_SCROLL_STEP = tuiTokens.layout.scrollStep
const TUI_MOUSE_MODE = resolveMouseModeEnabled(process.env.ORCANA_TUI_MOUSE)

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

/** Depthline P4: 浏览态 block 导航键。 */
function matchBlockNavKey(input: string, key: { return: boolean; ctrl: boolean; shift: boolean }): ActionId | null {
  if (key.ctrl || key.shift) return null
  if (input === "j") return "block.selectDown"
  if (input === "k") return "block.selectUp"
  if (key.return) return "block.toggle"
  if (input === " ") return "block.toggle"
  return null
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

export function buildModelOptions(runtime: Runtime, currentModel: string, query = "", providerFilter?: string): ModelDialogOption[] {
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
  const filteredProvider = providerFilter ? runtime.config.providers?.[providerFilter] : undefined
  // DeepSeek/Anthropic entries use their native Messages protocol. Relay
  // endpoints entered from those filtered views are normally OpenAI-compatible,
  // so route them through the explicit custom provider instead of silently
  // inheriting an incompatible wire protocol.
  const canReuseFilteredProvider = filteredProvider
    && filteredProvider.type !== "deepseek"
    && filteredProvider.type !== "anthropic"
  const customProviderId = canReuseFilteredProvider ? providerFilter! : "custom"
  const showCustom = !providerFilter || Boolean(filteredProvider)
  const customOption: ModelDialogOption[] = showCustom ? [{
    providerId: customProviderId,
    providerName: canReuseFilteredProvider ? filteredProvider.displayName ?? providerFilter! : "OpenAI-compatible",
    modelId: "__custom__",
    modelName: "自定义模型",
    configured: runtime.isProviderConfigured(customProviderId),
    current: false,
    tier: "custom",
    thinking: false,
    contextWindow: 128_000,
    custom: true,
  }] : []
  return [...catalogOptions, ...customOption]
}

function effortLabel(value: ThinkEffort): string {
  if (value === "auto") return "自动"
  if (value === "high") return "高"
  return "最大"
}

function useAgentStream(
  runtime: Runtime,
  prompt: string | undefined,
  controlsRef: React.MutableRefObject<{
    openModels: (provider?: string) => void
    openEffort: () => void
    dispatchAction: (id: string) => void
  }>,
  store: TuiStore,
  exitArmedRef: React.MutableRefObject<boolean>,
) {
  const adapterRef = useRef<StreamEventAdapter | null>(null)
  if (adapterRef.current === null) {
    adapterRef.current = new StreamEventAdapter()
  }
  const adapter = adapterRef.current

  // Phase 2: Stream trace (ORCANA_TUI_TRACE_STREAM=1)
  const traceRef = useRef<StreamTraceState>(createStreamTrace())

  // Subscribe to TuiStore — re-renders on every dispatch/dispatchMany
  const state = useSyncExternalStore(
    (cb: () => void) => store.subscribe(cb),
    () => store.getState(),
    () => store.getState(),
  )

  const historyRef = useRef<Array<{ role: ModelHistoryRole; content: string }>>([])
  const runningRef = useRef(false)
  const cancelCurrentRef = useRef<() => void>(() => {})
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
    let runId: string | undefined
    let textBuf = ""
    let assistantText = ""
    let lastFlush = 0
    const finishRun = () => {
      cancelCurrentRef.current = () => {}
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

    // Bug 修复：user.message 必须在 run 启动前 dispatch，
    // 确保 user message 总是显示（即使后续抛错）。
    store.dispatch({ type: "user.message", text: p })

    // H1: 动态选项走 run metadata；运行时依赖由 harness 注入。
    // 取消通过 harness.cancel(runId)（runId 取自首个事件）。
    const metadata: Record<string, unknown> = {
      [LEGACY_CONVERSATION_HISTORY]: historySnapshot,
      [LEGACY_THINK_EFFORT]: thinkEffort === "auto" ? undefined : thinkEffort,
      [LEGACY_RUN_TRACE]: runtime.startRunTrace(p),
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
      for await (const ev of runtime.harness.run(runtime.sessionId, { prompt: p, metadata })) {
        if (cancelled) return
        runId ??= ev.runId
        const payload = ev.payload

        // clarification needs local side effects (history, wizard state)
        if ("clarification" in payload) {
          const d = payload.clarification.questions as ClarificationReady
          flush()
          // Dispatch clarification.ready to TuiStore (sets status, done, pending message)
          store.dispatchMany(adapter.adaptHarnessEvent(ev))
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
        if ("text" in payload) {
          assistantText += payload.text
          textBuf += payload.text
          markTokenActivity() // Phase 5: stalled detection
          if (Date.now() - lastFlush > TUI_STREAM_FLUSH_MS) flush()
          continue
        }

        // All other events: translate via adapter and batch-dispatch
        const tuiEvents = adapter.adaptHarnessEvent(ev)
        if (tuiEvents.length > 0) {
          // Phase 5: stalled detection — tool events keep the watchdog alive
          if (tuiEvents.some(e => e.type.startsWith("tool."))) {
            markToolActivity()
          }
          store.dispatchMany(tuiEvents)
        }

        // Phase 0: capture provider stop_reason + stream error in TUI trace
        if ("display" in payload && payload.display.kind === "status" && typeof payload.display.data === "string") {
          const stopMatch = payload.display.data.match(/^provider-stop:\s*(.+)/)
          if (stopMatch) traceSetStopReason(traceRef.current, stopMatch[1]!)
        }
        if ("error" in payload) {
          traceSetStreamError(traceRef.current, payload.error)
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

    cancelCurrentRef.current = () => {
      cancelled = true
      if (runId) void runtime.harness.cancel(runId, "agent run cancelled")
    }
    return () => cancelCurrentRef.current()
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

  const answerQuestion = useCallback((answer: string) => {
    store.dispatch({ type: "user.message", text: answer })
    store.dispatch({
      type: "ui.event_message",
      kind: "activity",
      text: `用户回答了问题：${answer.slice(0, 50)}${answer.length > 50 ? "..." : ""}`,
      minIntervalMs: 0,
    })
    // user.message reducer 会清除 pendingQuestion 状态
    store.dispatch({ type: "ui.status", text: "processing answer..." })
    // 将回答作为新的用户消息注入 agent loop
    setTimeout(() => runAgent(answer), 0)
  }, [store, runAgent])

  const cancelQuestion = useCallback(() => {
    // 仅清除挂起的问题面板，不重置 run（agent 循环软暂停后自行继续）
    store.dispatch({ type: "user.question.cancel" })
    addSystemMessage("问题已取消，继续当前任务。")
  }, [store, addSystemMessage])

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
        if (exitArmedRef.current) {
          cleanupTerminal()
          runtime.dispose()
          process.exit(0)
        }
        exitArmedRef.current = true
        setTimeout(() => { exitArmedRef.current = false }, 5000)
        store.dispatch({ type: "ui.event_message", kind: "activity", text: "再输入一次 /exit 确认退出。", minIntervalMs: 0 })
      },
      openModels: controlsRef.current.openModels,
      openEffort: controlsRef.current.openEffort,
      setThinkEffort,
      dispatchAction: controlsRef.current.dispatchAction,
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
  }, [addSystemMessage, runAgent, store, adapter, runtime, controlsRef, setThinkEffort])

  useEffect(() => {
    if (!prompt?.trim()) return
    return runAgent(prompt)
  }, [prompt, runAgent])

  return { state, submit, clarification, answerClarification, moveClarificationSelection, cancelClarification, answerQuestion, cancelQuestion, store, thinkEffort, setThinkEffort, stopRun: () => cancelCurrentRef.current() }
}

export function ChatApp({ prompt, runtime }: { prompt?: string; runtime: Runtime }) {
  const { stdout } = useStdout()
  const rows = Math.max(24, stdout.rows ?? 32)
  const cols = stdout.columns ?? 96
  const thinkEffortRef = useRef<ThinkEffort>("auto")

  // Depthline P1: store 创建前移（原在 useAgentStream 内部），供 overlay controller 复用
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
    if (prompt?.trim()) {
      storeRef.current.dispatch({ type: "ui.status", text: "starting..." })
      storeRef.current.dispatch({ type: "ui.done", done: false })
    }
  }
  const store = storeRef.current

  // Depthline P1: overlay 互斥状态 + settings 对话框按键由 controller 接管。
  // controls 经 ref 注入 useAgentStream，避免 controller 与 stream hook 的循环依赖。
  const controlsRef = useRef({ openModels: () => {}, openEffort: () => {}, dispatchAction: (id: string) => {} })
  // 退出保护：/exit 双确认 + Ctrl+C 双按（运行任务时第一下只停止）
  const exitArmedRef = useRef(false)
  const { state, submit, clarification, answerClarification, moveClarificationSelection, cancelClarification, answerQuestion, cancelQuestion, thinkEffort, setThinkEffort, stopRun } = useAgentStream(runtime, prompt, controlsRef, store, exitArmedRef)
  thinkEffortRef.current = thinkEffort
  const overlayController = useOverlayController({
    runtime,
    store,
    getCurrentModel: () => runtime.modelRouter.getSessionModel(),
    getCurrentEffort: () => thinkEffortRef.current,
    setThinkEffort,
    buildOptions: (query, providerFilter) => buildModelOptions(runtime, runtime.modelRouter.getSessionModel(), query, providerFilter),
  })
  // controlsRef.current 在 actionContext 定义后赋值（submit 仅在用户操作时触发）
  const [scrollOffset, setScrollOffset] = useState(0)
  const [scrollState, setScrollState] = useState<ScrollbackScrollState>({ maxOffset: 0, normalizedOffset: 0, hiddenAbove: false, hiddenBelow: false })
  const previousMaxOffsetRef = useRef(0)
  const [autoFollow, setAutoFollow] = useState(true)
  const [inputChrome, setInputChrome] = useState<InputChromeState>({ commandOpen: false, pasteCount: 0, textRows: 1 })
  const [showStartup, setShowStartup] = useState(process.env.ORCANA_TUI_SPLASH !== "off")
  const isWorking = !state.done && !state.errorLine

  // Depthline P1: 布局单一事实源（useAppLayout），原重复手算已删除
  const layout = useAppLayout({
    rows,
    cols,
    state,
    clarification,
    inputChrome,
    overlayActive: overlayController.overlay.kind !== "none",
  })

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
    if (!showStartup) return
    const timer = setTimeout(() => setShowStartup(false), TUI_STARTUP_MS)
    return () => clearTimeout(timer)
  }, [showStartup])

  // Phase 5: 键位上下文分发 — 扩大到 Confirm/RewindList/RewindConfirm
  // PR-5: 新增 CommandShelf context — 命令菜单打开时不让 Scrollback 抢键
  const activeKeyContext = resolveActiveContext({
    clarificationActive: !!clarification,
    confirmActive: overlayController.overlay.kind === "confirm",
    rewindListActive: overlayController.overlay.kind === "rewind" && overlayController.overlay.state.phase === "list",
    rewindConfirmActive: overlayController.overlay.kind === "rewind" && overlayController.overlay.state.phase === "confirm",
    commandOpen: inputChrome.commandOpen,
    runtimeDialogActive: overlayController.overlay.kind === "settings",
  })

  // Depthline P4: 转录块 + 视图状态（折叠/选中独立于派生结果）
  const blocks = useMemo(() => deriveTranscriptBlocks(state), [state])
  const [viewState, dispatchView] = useReducer(reduceTranscriptViewState, undefined, createInitialTranscriptViewState)

  const selectableBlocks = useMemo(() => blocks.filter(b => b.selectable), [blocks])
  const blockNav = useMemo(() => {
    const current = viewState.selectedBlockId
    const idx = selectableBlocks.findIndex(b => b.id === current)
    return {
      selectUp: () => {
        const next = idx > 0 ? selectableBlocks[idx - 1] : (idx === -1 ? selectableBlocks[selectableBlocks.length - 1] : undefined)
        if (next) dispatchView({ type: "block.select", blockId: next.id })
      },
      selectDown: () => {
        const next = idx >= 0 && idx < selectableBlocks.length - 1 ? selectableBlocks[idx + 1] : (idx === -1 ? selectableBlocks[0] : undefined)
        if (next) dispatchView({ type: "block.select", blockId: next.id })
      },
      toggle: () => {
        const target = idx >= 0 ? selectableBlocks[idx] : selectableBlocks[0]
        if (!target) return
        if (current === null) {
          dispatchView({ type: "block.select", blockId: target.id })
        }
        dispatchView({ type: "block.toggle", blockId: target.id })
      },
      clear: () => dispatchView({ type: "block.select", blockId: null }),
    }
  }, [selectableBlocks, viewState.selectedBlockId, dispatchView])

  // Depthline P3: ActionExecutionContext — 单一执行上下文
  const selectClarificationOption = useCallback(() => {
    const q = clarification?.questions[clarification.index]
    if (!q) return
    const opt = q.options[clarification.selected]
    if (opt) answerClarification({ question: q.title, key: opt.key, label: opt.label })
  }, [clarification, answerClarification])

  const actionContext = useMemo<ActionExecutionContext>(() => ({
    store,
    runtime,
    isWorking,
    overlay: overlayController.overlay,
    bodyHeight: layout.bodyHeight,
    scrollStep: TUI_SCROLL_STEP,
    scrollUp,
    scrollDown,
    moveClarificationSelection,
    selectClarificationOption,
    cancelClarification,
    updateOverlay: overlayController.updateOverlay,
    closeOverlay: overlayController.closeOverlay,
    stopRun,
    blockNav,
  }), [store, runtime, isWorking, overlayController.overlay, layout.bodyHeight, scrollUp, scrollDown, moveClarificationSelection, selectClarificationOption, cancelClarification, overlayController.updateOverlay, overlayController.closeOverlay, stopRun, blockNav])

  controlsRef.current.dispatchAction = (id) => dispatchAction(id as import("./presentation/actions").ActionId, actionContext)
  // 修复：/models、/effort 等斜杠命令经 dispatcher 调用 openModels/openEffort，
  // 必须接到 overlayController 的面板打开器，否则命令"handled"但无任何反应。
  controlsRef.current.openModels = overlayController.openModelPicker
  controlsRef.current.openEffort = overlayController.openEffort

  useInput((_input, key) => {
    // Ctrl+C 双按保护（exitOnCtrlC 已关闭；splash 期间也直接退出）：
    //   idle/startup → 直接退出；working → 第一下停止任务并提示，3s 内再按退出
    if (key.ctrl && _input.toLowerCase() === "c") {
      if (exitArmedRef.current) {
        cleanupTerminal()
        runtime.dispose()
        process.exit(0)
      }
      if (showStartup || !isWorking) {
        cleanupTerminal()
        runtime.dispose()
        process.exit(0)
      }
      exitArmedRef.current = true
      setTimeout(() => { exitArmedRef.current = false }, 3000)
      stopRun()
      store.dispatch({ type: "ui.event_message", kind: "activity", text: "任务已停止。再按一次 Ctrl+C 退出 Orcana。", minIntervalMs: 0 })
      return
    }
    if (showStartup) return
    // Depthline P1: settings 对话框按键由 controller 消费（不泄漏到 keymap）
    if (overlayController.overlay.kind === "settings") {
      overlayController.handleSettingsKey(_input, key)
      return
    }
    // Depthline P3: shortcuts 面板 — Esc 关闭，其余键吞掉
    if (overlayController.overlay.kind === "shortcuts") {
      if (key.escape) overlayController.closeOverlay()
      return
    }
    // Depthline P4: 浏览态（有选中块或已上滚）→ j/k/Enter/Space 走 block 导航
    const blockNavActive = viewState.selectedBlockId !== null || scrollOffset > 0
    if (blockNavActive && activeKeyContext === "Scrollback") {
      const blockKey = matchBlockNavKey(_input, key)
      if (blockKey) {
        dispatchAction(blockKey, actionContext)
        return
      }
      if (key.escape && viewState.selectedBlockId !== null) {
        dispatchView({ type: "block.select", blockId: null })
        return
      }
    }
    // Depthline P3: 统一 ActionRegistry 分发（keymap/hints/面板同一数据源）
    const matched = matchAction(_input, key, activeKeyContext)
    if (matched) {
      dispatchAction(matched.id, actionContext)
      return
    }
    // 未命中 → pass through to composer
    // isActive 恒为 true：splash 期间也必须能处理 Ctrl+C（exitOnCtrlC 已关闭），其余按键在 showStartup 时被吞
  }, { isActive: true })

  useEffect(() => {
    if (autoFollow) setScrollOffset(0)
  }, [autoFollow, state.messages.length])

  useEffect(() => {
    const previousMaxOffset = previousMaxOffsetRef.current
    setScrollOffset(offset => adjustScrollOffsetForGrowth(
      offset,
      previousMaxOffset,
      scrollState.maxOffset,
      autoFollow,
    ))
    previousMaxOffsetRef.current = scrollState.maxOffset
  }, [autoFollow, scrollState.maxOffset])

  // 鼠标滚轮滚动默认由应用接管，因此运行中、输入中和弹窗中都能滚动历史。
  // ORCANA_TUI_MOUSE=0 可显式退回终端原生选择/alternate-scroll 模式。
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
    <>
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
        overlay={overlayController.overlay}
        blocks={blocks}
        view={viewState}
        onView={dispatchView}
        thinkingEffort={thinkEffort}
        onAnswerQuestion={answerQuestion}
        onCancelQuestion={cancelQuestion}
      />
    </>
  )
}

export async function startInkTUI(prompt?: string) {
  // Depthline P1: ORCANA_TUI_PROFILE=1 时记录 render/timer 指标，退出时输出
  installProfileReporter()
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
  const projectDir = process.cwd().split(/[/\\]/).pop() ?? "orcana"
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
    // 关闭 ink 默认 Ctrl+C 直退：由 useInput 接管双按保护（运行任务时第一下仅停止）
    { exitOnCtrlC: false },
  )
  try {
    return await waitUntilExit()
  } finally {
    process.off("SIGINT", sigintHandler)
    cleanupTerminal()
    runtime.dispose()
  }
}
