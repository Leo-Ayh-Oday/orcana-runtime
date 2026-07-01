import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { render, useInput, useStdin, useStdout } from "ink"
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
import type { ScrollbackScrollState } from "./components/Scrollback"
import type { TaskProgressState } from "./components/PlanPanel"
import { formatHelpText, isSafeConcurrent, commandExists } from "./commands/registry"
import { selectGateSummary, selectEvidenceSummary } from "./state/selectors"

type ModelHistoryRole = "user" | "assistant"

const TUI_STARTUP_MS = 2400
const TUI_STREAM_FLUSH_MS = Number(process.env.DEEPSEEK_TUI_STREAM_FLUSH_MS ?? "120")
const TUI_FRAME_MS = Number(process.env.DEEPSEEK_TUI_FRAME_MS ?? "320")
const TUI_SCROLL_STEP = Number(process.env.DEEPSEEK_TUI_SCROLL_STEP ?? "3")

function TuiInputGuard() {
  useInput(() => {
    // Keep stdin in raw mode for the whole TUI so the host shell never echoes
    // typed characters below the Ink-rendered input box.
  })
  return null
}

function useMouseWheelScroll(active: boolean, onScrollUp: () => void, onScrollDown: () => void) {
  const { stdin } = useStdin()
  const { stdout } = useStdout()

  useEffect(() => {
    if (!active || !stdin?.on || !stdout?.write || stdout.isTTY === false) return

    // SGR mouse mode + normal tracking. Do not enable 1002/1003 here: they can
    // flood the TUI with motion events and make Ink feel laggy.
    const enableMouse = "\x1b[?1000h\x1b[?1006h"
    const disableMouse = "\x1b[?1006l\x1b[?1000l"

    stdout.write(enableMouse)

    const handleWheel = (code: number) => {
      if (code === 64) onScrollUp()
      if (code === 65) onScrollDown()
    }

    const handleData = (data: Buffer | string) => {
      const text = data.toString("utf8")

      // Modern xterm / Windows Terminal / VS Code terminal: ESC [ < code ; x ; y M
      for (const match of text.matchAll(/\x1b\[<(\d+);\d+;\d+[mM]/g)) {
        handleWheel(Number(match[1]))
      }

      // Legacy X10 mouse sequence: ESC [ M Cb Cx Cy
      for (let index = 0; index <= text.length - 6; index += 1) {
        if (text.charCodeAt(index) === 0x1b && text[index + 1] === "[" && text[index + 2] === "M") {
          handleWheel(text.charCodeAt(index + 3) - 32)
        }
      }
    }

    stdin.on("data", handleData)
    return () => {
      stdin.off?.("data", handleData)
      stdout.write(disableMouse)
    }
  }, [active, stdin, stdout, onScrollUp, onScrollDown])
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
    const opts: AgentOptions = runtime.buildAgentOptions({
      model: runtime.modelRouter.selectForPurpose("agent_main"),
      tools: runtime.tools,
      maxRounds: 30,
      conversationHistory: historySnapshot,
      gateTelemetryFile: ".wolf/gate-telemetry.json",
    })

    let cancelled = false
    let textBuf = ""
    let assistantText = ""
    let lastFlush = 0
    const finishRun = () => {
      runningRef.current = false
      const nextPrompt = queuedPromptsRef.current.shift()
      store.dispatch({ type: "ui.queue_count", count: queuedPromptsRef.current.length })
      if (nextPrompt) {
        setTimeout(() => runAgentRef.current(nextPrompt), 0)
      }
    }

    // user.message creates user & pending assistant messages and resets run state
    store.dispatch({ type: "user.message", text: p })

    const flush = () => {
      if (!textBuf) return
      const chunk = textBuf
      textBuf = ""
      lastFlush = Date.now()
      store.dispatch({ type: "assistant.delta", text: chunk })
    }

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
      historyRef.current = [
        ...historySnapshot,
        { role: "user", content: p },
        ...(assistantText.trim() ? [{ role: "assistant" as const, content: compactAssistantText(assistantText) }] : []),
      ]
      // assistant.final("") marks pending message non-pending, preserves accumulated text
      store.dispatch({ type: "assistant.final", text: "" })
      store.dispatch({ type: "ui.done", done: true })
      store.dispatch({ type: "ui.status", text: "done" })
      finishRun()
    })().catch(error => {
      const message = error instanceof Error ? error.message : String(error)
      flush()
      store.dispatch({ type: "ui.error_line", text: message })
      store.dispatch({ type: "ui.done", done: true })
      store.dispatch({ type: "assistant.final", text: message })
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
    const command = newPrompt.trim()

    // ── 斜杠命令分发 ──
    if (command.startsWith("/")) {
      const [name = ""] = command.slice(1).split(/\s+/, 1)

      // 已知命令：检查安全并发性
      if (commandExists(name)) {
        // agent 忙碌时，非安全命令直接拒绝（不静默排队）
        if (runningRef.current && !isSafeConcurrent(name)) {
          addSystemMessage(`Command /${name} is not available while the agent is running. Wait for it to finish or use /status to check progress.`)
          return
        }

        // ── 系统命令 ──
        if (name === "exit" || name === "quit") {
          process.exit(0)
        }
        if (name === "help") {
          addSystemMessage(formatHelpText())
          return
        }

        // ── 会话命令 ──
        if (name === "clear") {
          historyRef.current = []
          setClarification(null)
          adapter.reset()
          store.reset()
          return
        }
        if (name === "stats") {
          const s = store.getState()
          addSystemMessage(
            [
              `messages ${historyRef.current.length}`,
              `model ${s.modelName}`,
              `tokens in ${s.tokens.inputTokens} / out ${s.tokens.outputTokens} / max ${s.tokens.contextMax}`,
              `cache hit ${s.tokens.cacheHitRate ?? 0}%`,
              `round ${s.round}`,
            ].join("  ·  "),
          )
          return
        }

        // ── Orcana 引擎数据命令 ──
        if (name === "ripple") {
          const s = store.getState()
          if (s.rippleFindings.length === 0) {
            addSystemMessage("No ripple findings yet. Run a task to trigger ripple scan.")
          } else {
            const lines = s.rippleFindings.map(f => `  ${f.file} [${f.severity}] ${f.reason}`)
            addSystemMessage(`Ripple findings (${s.rippleFindings.length}):\n${lines.join("\n")}`)
          }
          return
        }
        if (name === "gates") {
          const s = store.getState()
          const summary = selectGateSummary(s)
          if (summary.total === 0) {
            addSystemMessage("No gates recorded yet.")
          } else {
            const lines = s.gates.map(g => `  ${g.gate}: ${g.status}${g.reason ? ` — ${g.reason}` : ""}`)
            addSystemMessage(`Gates (${summary.total}: ${summary.pass} pass / ${summary.block} block / ${summary.skip} skip):\n${lines.join("\n")}`)
          }
          return
        }
        if (name === "evidence") {
          const s = store.getState()
          const summary = selectEvidenceSummary(s)
          if (summary.total === 0) {
            addSystemMessage("No evidence recorded yet.")
          } else {
            const lines = s.evidence.map(e => `  ${e.kind}: ${e.status} — ${e.summary}`)
            addSystemMessage(`Evidence (${summary.total}: ${summary.passed} passed / ${summary.failed} failed / ${summary.skipped} skipped):\n${lines.join("\n")}`)
          }
          return
        }
        if (name === "patches") {
          const s = store.getState()
          if (s.patches.length === 0) {
            addSystemMessage("No patch transactions yet.")
          } else {
            const lines = s.patches.map(p => `  ${p.txId}: ${p.status} — ${p.files.length} files${p.summary ? ` — ${p.summary}` : ""}`)
            addSystemMessage(`Patches (${s.patches.length}):\n${lines.join("\n")}`)
          }
          return
        }
        if (name === "models") {
          const s = store.getState()
          addSystemMessage(
            [
              `model ${s.modelName}`,
              `provider ${s.session.provider ?? "default"}`,
              `session ${s.session.sessionId ?? "—"}`,
              `branch ${s.session.branch ?? "—"}`,
            ].join("  ·  "),
          )
          return
        }
        if (name === "status") {
          const s = store.getState()
          const gateSummary = selectGateSummary(s)
          const evidenceSummary = selectEvidenceSummary(s)
          addSystemMessage(
            [
              `Status: ${s.status}`,
              `Model: ${s.modelName}`,
              `Mode: ${s.mode}`,
              `Round: ${s.round}`,
              `Done: ${s.done ? "yes" : "no"}`,
              `Queue: ${s.queueCount}`,
              `Tokens: ${s.tokens.inputTokens} in / ${s.tokens.outputTokens} out / ${s.tokens.contextMax} max`,
              `Cache: ${s.tokens.cacheHitRate ?? 0}%`,
              `Gates: ${gateSummary.pass}p/${gateSummary.block}b/${gateSummary.skip}s`,
              `Evidence: ${evidenceSummary.passed}p/${evidenceSummary.failed}f/${evidenceSummary.skipped}s`,
              `Tools: ${s.tools.length}`,
              `Patches: ${s.patches.length}`,
            ].join("\n"),
          )
          return
        }

        // 未实现处理的已知命令（save/compact/sessions/search/undo/effort）
        // 落到 agent 执行，让 agent 处理
      }
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
  }, [addSystemMessage, runAgent, store, adapter])

  useEffect(() => {
    if (!prompt?.trim()) return
    return runAgent(prompt)
  }, [prompt, runAgent])

  return { state, submit, clarification, answerClarification, moveClarificationSelection, cancelClarification }
}

export function ChatApp({ prompt, runtime }: { prompt?: string; runtime: Runtime }) {
  const { stdout } = useStdout()
  const rows = Math.max(24, stdout.rows ?? 32)
  const cols = stdout.columns ?? 96
  const { state, submit, clarification, answerClarification, moveClarificationSelection, cancelClarification } = useAgentStream(runtime, prompt)
  const [tick, setTick] = useState(0)
  const [scrollOffset, setScrollOffset] = useState(0)
  const [scrollState, setScrollState] = useState<ScrollbackScrollState>({ maxOffset: 0, normalizedOffset: 0, hiddenAbove: false, hiddenBelow: false })
  const [autoFollow, setAutoFollow] = useState(true)
  const [inputChrome, setInputChrome] = useState<InputChromeState>({ commandOpen: false, pasteCount: 0 })
  const [showStartup, setShowStartup] = useState(process.env.DEEPSEEK_TUI_SPLASH !== "off")
  const mouseScrollEnabled = process.env.DEEPSEEK_TUI_MOUSE !== "off"
  // TuiState.task 是 unknown（reducer 不感知 TaskProgressState 形状），这里做一次类型收窄
  const task = state.task as TaskProgressState | undefined
  const isWorking = !state.done && !state.errorLine

  // 布局计算（与 AppShell 保持一致：useInput 的 PageUp/PageDown 需要 bodyHeight）
  const question = clarification?.questions[clarification.index]
  const clarificationRows = clarification ? Math.min(10, 4 + (question?.options.length ?? 0)) : 0
  const taskRows = task ? (task.phase === "planning" ? 3 : Math.min(5, 1 + Math.min(3, task.steps.length))) : 0
  const panelRows = clarificationRows || taskRows
  const inputRows = inputChrome.commandOpen ? 5 : (isWorking || inputChrome.pasteCount > 0 ? 2 : 1)
  const footerHeight = Math.max(1, Math.min(rows - 8, panelRows + inputRows))
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

  useMouseWheelScroll(mouseScrollEnabled && !showStartup, () => scrollUp(TUI_SCROLL_STEP), () => scrollDown(TUI_SCROLL_STEP))

  useInput((_input, key) => {
    if (showStartup) return
    if (clarification) {
      const question = clarification.questions[clarification.index]
      if ((_input === "k" || key.upArrow) && question) {
        moveClarificationSelection(-1)
        return
      }
      if ((_input === "j" || key.downArrow) && question) {
        moveClarificationSelection(1)
        return
      }
      if (key.return && question) {
        const option = question.options[clarification.selected]
        if (option) answerClarification({ question: question.title, key: option.key, label: option.label })
        return
      }
      if (key.escape) {
        cancelClarification()
        return
      }
      return
    }
    if (key.pageUp) {
      scrollUp(Math.max(3, bodyHeight - 4))
      return
    }
    if (key.pageDown) {
      scrollDown(Math.max(3, bodyHeight - 4))
      return
    }
    if (key.ctrl && key.upArrow) {
      scrollUp(3)
      return
    }
    if (key.ctrl && key.downArrow) {
      scrollDown(3)
    }
  }, { isActive: !showStartup })

  useEffect(() => {
    if (autoFollow) setScrollOffset(0)
  }, [autoFollow, state.messages.length])

  useEffect(() => {
    setScrollOffset(offset => Math.min(offset, scrollState.maxOffset))
  }, [scrollState.maxOffset])

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
      />
    </>
  )
}

export async function startInkTUI(prompt?: string) {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    console.error("DEEPSEEK_API_KEY not set")
    process.exit(1)
  }
  // Lazy-import to avoid circular dependency at module load time
  const { createRuntime } = await import("../runtime/bootstrap")
  const runtime = await createRuntime({
    projectRoot: process.cwd(),
    enableMCP: true,
    enableLSP: true,
  })
  const { waitUntilExit } = render(<ChatApp prompt={prompt} runtime={runtime} />)
  try {
    return await waitUntilExit()
  } finally {
    runtime.dispose()
  }
}
