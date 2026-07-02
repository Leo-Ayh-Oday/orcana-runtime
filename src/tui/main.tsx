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
import { ErrorBoundary } from "./components/ErrorBoundary"
import type { ScrollbackScrollState } from "./components/Scrollback"
import type { TaskProgressState } from "./components/PlanPanel"
import { renderMessageLines } from "./components/MessageItem"
import { dispatchTuiCommand } from "./commands/dispatcher"
import { resolveActiveContext } from "./input/types"
import { resolveKeyAction } from "./input/keymap"
import { cleanupTerminal, mouseEvents } from "./stdin-filter"
import { createStreamTrace, traceStartRound, traceDeltaChunk, traceFinalAccumulated, traceEndRound } from "./stream-trace"
import type { StreamTraceState } from "./stream-trace"
import type { ConfirmRequest } from "./confirm-stubs"
import type { RewindModalState } from "./components/RewindModal"

type ModelHistoryRole = "user" | "assistant"

// ── Phase 5: Modal state ──

interface TuiModalState {
  confirm: { request: ConfirmRequest; position: string } | null
  rewind: RewindModalState | null
}

function emptyModalState(): TuiModalState {
  return { confirm: null, rewind: null }
}

/** 是否有任何 modal 激活 → composer disabled */
function isModalActive(modal: TuiModalState): boolean {
  return modal.confirm !== null || modal.rewind !== null
}

import { tuiTokens } from "./tokens"

const TUI_STARTUP_MS = tuiTokens.motion.startupMs
const TUI_STREAM_FLUSH_MS = tuiTokens.motion.streamFlushMs
const TUI_FRAME_MS = tuiTokens.motion.frameMs
const TUI_SCROLL_STEP = tuiTokens.layout.scrollStep

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

function useAgentStream(runtime: Runtime, prompt?: string) {
  const storeRef = useRef<TuiStore | null>(null)
  if (storeRef.current === null) {
    storeRef.current = new TuiStore()
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

  const addSystemMessage = useCallback((content: string) => {
    store.dispatch({ type: "assistant.final", text: content })
    store.dispatch({ type: "ui.done", done: true })
    store.dispatch({ type: "ui.status", text: "ready" })
    store.dispatch({ type: "ui.error_line", text: "" })
  }, [store])

  const runAgent = useCallback((p: string) => {
    runningRef.current = true
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
        conversationHistory: historySnapshot,
        gateTelemetryFile: ".wolf/gate-telemetry.json",
        runTrace: runtime.startRunTrace(p),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
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
          if (Date.now() - lastFlush > TUI_STREAM_FLUSH_MS) flush()
          continue
        }

        // All other events: translate via adapter and batch-dispatch
        const tuiEvents = adapter.adapt(ev)
        if (tuiEvents.length > 0) {
          store.dispatchMany(tuiEvents)
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
      const message = error instanceof Error ? error.message : String(error)
      flush()
      traceFinalAccumulated(traceRef.current, message.length, true)
      store.dispatch({ type: "ui.error_line", text: message })
      store.dispatch({ type: "ui.done", done: true })
      store.dispatch({ type: "assistant.final", text: message })
      traceRenderedAssistant(traceRef.current, store, message.length)
      finishRun()
    })

    return () => { cancelled = true }
  }, [runtime, store, adapter])

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
  }, [addSystemMessage, runAgent, store, adapter, runtime])

  useEffect(() => {
    if (!prompt?.trim()) return
    return runAgent(prompt)
  }, [prompt, runAgent])

  return { state, submit, clarification, answerClarification, moveClarificationSelection, cancelClarification, store }
}

export function ChatApp({ prompt, runtime }: { prompt?: string; runtime: Runtime }) {
  const { stdout } = useStdout()
  const rows = Math.max(24, stdout.rows ?? 32)
  const cols = stdout.columns ?? 96
  const { state, submit, clarification, answerClarification, moveClarificationSelection, cancelClarification, store } = useAgentStream(runtime, prompt)
  const [tick, setTick] = useState(0)
  const [scrollOffset, setScrollOffset] = useState(0)
  const [scrollState, setScrollState] = useState<ScrollbackScrollState>({ maxOffset: 0, normalizedOffset: 0, hiddenAbove: false, hiddenBelow: false })
  const [autoFollow, setAutoFollow] = useState(true)
  const [inputChrome, setInputChrome] = useState<InputChromeState>({ commandOpen: false, pasteCount: 0, textRows: 1 })
  const [showStartup, setShowStartup] = useState(process.env.DEEPSEEK_TUI_SPLASH !== "off")
  // Phase 5: Modal state (confirm + rewind)
  const [modal, setModal] = useState<TuiModalState>(emptyModalState)
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
  const activeKeyContext = resolveActiveContext({
    clarificationActive: !!clarification,
    confirmActive: modal.confirm !== null,
    rewindListActive: modal.rewind?.phase === "list",
    rewindConfirmActive: modal.rewind?.phase === "confirm",
  })

  useInput((_input, key) => {
    if (showStartup) return
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

  // 鼠标滚轮滚动：stdin-filter 解析 SGR 滚轮事件并通过 EventEmitter 分发
  useEffect(() => {
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
        tick={tick}
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
      />
    </>
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
  })

  // Bug 修复：安装 stdin 过滤器拦截鼠标序列。
  // react-ink-textarea 的 useKeyboardInput fallback 分支会插入任何非空 input，
  // 包括 SGR 鼠标序列（\x1B[<0;40;10M），导致滚轮在输入框产生乱码。
  // 必须在 render 之前安装，确保过滤后的数据才到达 Ink。
  const { installStdinFilter, enableMouseMode } = await import("./stdin-filter")
  installStdinFilter()
  enableMouseMode()

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
