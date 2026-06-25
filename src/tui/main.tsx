import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Box, Text, render, useInput, useStdin, useStdout } from "ink"
import { agentLoop } from "../agent/loop"
import type { AgentOptions } from "../agent/loop-types"
import { DeepSeekProvider } from "../provider/deepseek"
import { buildTools } from "../tools/registry"
import { READ_FILE, WRITE_FILE, EDIT_FILE, MULTI_EDIT } from "../tools/file"
import { SHELL_TOOL } from "../tools/shell"
import { WEB_SEARCH } from "../tools/search"
import { WEB_FETCH_TOOL } from "../tools/webfetch"
import { PROJECT_STRUCTURE, FIND_SYMBOL, FIND_REFERENCES } from "../tools/codegraph"
import { GIT_STATUS, GIT_DIFF, GIT_LOG } from "../tools/git"
import { START_SERVICE_TOOL } from "../tools/service"
import { InkStartupScreen } from "../ui/ink-startup"
import { Dashboard, type DashProps } from "./dashboard"
import { InputLine, type SlashCommandHint } from "./input"
import { CLARIFICATION_MARKER, type ClarificationQuestion, type ClarificationReady } from "../agent/clarification"
import { cleanDisplayText, fitTerminalText, formatDisplayText, trimForViewport } from "./format"

const C = {
  cyan: "#38BDF8",
  blue: "#60A5FA",
  white: "#E5E7EB",
  dim: "#64748B",
  green: "#22C55E",
  yellow: "#F59E0B",
  red: "#EF4444",
  border: "#334155",
}

type TaskStepStatus = "pending" | "running" | "done" | "failed"

interface TaskProgressState {
  goal: string
  phase: "planning" | "building" | "complete"
  done: number
  total: number
  current: string
  steps: Array<{ id: string; title: string; status: TaskStepStatus; evidence?: string }>
}

interface TranscriptScrollState {
  maxOffset: number
  normalizedOffset: number
  hiddenAbove: boolean
  hiddenBelow: boolean
}

interface AgentState {
  text: string
  status: string
  telemetry: string
  modelName: string
  messages: ChatMessage[]
  dash: DashProps
  task: TaskProgressState | null
  done: boolean
  error: string
}

interface ClarificationWizardState {
  originalPrompt: string
  questions: ClarificationQuestion[]
  index: number
  selected: number
  answers: Array<{ question: string; key: string; label: string }>
  extraPrompt?: string
  rawText: string
}

type ChatRole = "user" | "assistant" | "event"
type ChatEventKind = "tool" | "task" | "plan" | "error"
type ModelHistoryRole = "user" | "assistant"

interface ChatMessage {
  id: number
  role: ChatRole
  content: string
  kind?: ChatEventKind
  pending?: boolean
  error?: boolean
}

const SLASH_COMMANDS: SlashCommandHint[] = [
  { name: "help", description: "Show commands" },
  { name: "clear", description: "Clear current conversation" },
  { name: "save", description: "Save this session" },
  { name: "compact", description: "Preview memory compaction", usage: "[preview]" },
  { name: "sessions", description: "List saved sessions" },
  { name: "search", description: "Search session history", usage: "<query>" },
  { name: "undo", description: "Undo last write" },
  { name: "stats", description: "Show token and cache stats" },
  { name: "effort", description: "Set thinking depth", usage: "<auto|high|max>" },
  { name: "exit", description: "Exit DeepSeek Code" },
]

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

function initialDash(): DashProps {
  return {
    round: 0,
    contextTokens: 0,
    contextMax: 1_048_576,
    cacheHitRate: 0,
    cacheHits: [],
    rippleFindings: [],
    toolHistory: [],
    taskProgress: { done: 0, total: 0, current: "" },
  }
}

function initialState(): AgentState {
  return {
    text: "",
    status: "starting...",
    telemetry: "",
    modelName: process.env.DEEPSEEK_MODEL_OVERRIDE ?? "deepseek-v4-pro",
    messages: [],
    dash: initialDash(),
    task: null,
    done: false,
    error: "",
  }
}

function useAgentStream(apiKey: string, prompt?: string) {
  const historyRef = useRef<Array<{ role: ModelHistoryRole; content: string }>>([])
  const messageIdRef = useRef(0)
  const lastEventRef = useRef<{ key: string; at: number } | null>(null)
  const [clarification, setClarification] = useState<ClarificationWizardState | null>(null)
  const [state, setState] = useState<AgentState>(() => ({
    ...initialState(),
    status: prompt?.trim() ? "starting..." : "ready",
    done: !prompt?.trim(),
  }))

  const addSystemMessage = useCallback((content: string) => {
    const assistantId = ++messageIdRef.current
    setState(prev => ({
      ...prev,
      done: true,
      status: "ready",
      error: "",
      messages: [
        ...prev.messages,
        { id: assistantId, role: "assistant", content },
      ],
    }))
  }, [])

  const addEventMessage = useCallback((kind: ChatEventKind, content: string, options: { dedupeKey?: string; minIntervalMs?: number } = {}) => {
    const trimmed = content.trim()
    if (!trimmed) return
    const key = options.dedupeKey ?? `${kind}:${trimmed}`
    const now = Date.now()
    const previous = lastEventRef.current
    if (previous?.key === key && now - previous.at < (options.minIntervalMs ?? 1000)) return
    lastEventRef.current = { key, at: now }
    const eventId = ++messageIdRef.current
    setState(prev => ({
      ...prev,
      messages: [
        ...prev.messages,
        { id: eventId, role: "event", kind, content: trimmed },
      ],
    }))
  }, [])

  const runAgent = useCallback((p: string) => {
    const historySnapshot = historyRef.current.slice()
    const userId = ++messageIdRef.current
    const assistantId = ++messageIdRef.current
    const provider = new DeepSeekProvider(apiKey)
    const allTools = buildTools(
      READ_FILE,
      WRITE_FILE,
      EDIT_FILE,
      MULTI_EDIT,
      SHELL_TOOL,
      WEB_SEARCH,
      WEB_FETCH_TOOL,
      PROJECT_STRUCTURE,
      FIND_SYMBOL,
      FIND_REFERENCES,
      GIT_STATUS,
      GIT_DIFF,
      GIT_LOG,
      START_SERVICE_TOOL,
    )
    const opts: AgentOptions = {
      provider,
      model: "deepseek-v4-pro",
      tools: allTools,
      maxRounds: 30,
      conversationHistory: historySnapshot,
      gateTelemetryFile: ".wolf/gate-telemetry.json",
    }

    let cancelled = false
    let textBuf = ""
    let assistantText = ""
    let lastFlush = 0

    setState(prev => ({
      ...prev,
      text: "",
      status: "starting...",
      done: false,
      error: "",
      dash: initialDash(),
      task: null,
      messages: [
        ...prev.messages,
        { id: userId, role: "user", content: p },
        { id: assistantId, role: "assistant", content: "", pending: true },
      ],
    }))

    const flush = () => {
      if (!textBuf) return
      const chunk = textBuf
      textBuf = ""
      lastFlush = Date.now()
      setState(prev => ({
        ...prev,
        text: prev.text + chunk,
        messages: prev.messages.map(message =>
          message.id === assistantId
            ? { ...message, content: appendAssistantText(message.content, chunk), pending: true }
            : message,
        ),
      }))
    }

    ;(async () => {
      for await (const ev of agentLoop(p, opts)) {
        if (cancelled) return
        switch (ev.type) {
          case "text":
            if (typeof ev.data === "string") {
              assistantText += ev.data
              textBuf += ev.data
              if (Date.now() - lastFlush > TUI_STREAM_FLUSH_MS) flush()
            }
            break
          case "status":
            if (typeof ev.data === "string") {
              const statusText = ev.data as string
              setState(s => ({ ...s, status: compactStatusText(statusText) }))
            }
            break
          case "task_progress": {
            const task = ev.data as TaskProgressState | null
            if (task) {
              const visibleTaskProgress = task.phase === "planning"
                ? { done: 0, total: 0, current: "" }
                : { done: task.done, total: task.total, current: task.current }
              setState(s => ({
                ...s,
                task,
                dash: { ...s.dash, taskProgress: visibleTaskProgress },
              }))
              const taskLine = task.phase === "planning"
                ? `planning gate: waiting for accepted model plan / ${task.goal}`
                : `task progress: ${task.done}/${task.total} ${task.current} / ${task.phase}`
              addEventMessage("task", taskLine, { dedupeKey: `task:${task.phase}:${task.done}:${task.current}`, minIntervalMs: 1000 })
            }
            break
          }
          case "tool_call": {
            const d = ev.data as { name?: string }
            if (d?.name) {
              addEventMessage("tool", `tool start: ${d.name}`, { dedupeKey: `tool-start:${d.name}`, minIntervalMs: 250 })
              setState(s => ({
                ...s,
                dash: { ...s.dash, toolHistory: [...s.dash.toolHistory.slice(-15), { name: d.name!, status: "running" }] },
              }))
            }
            break
          }
          case "tool_result": {
            const d = ev.data as { name?: string; content?: string }
            if (d?.name) {
              const summary = typeof d.content === "string" && d.content.trim()
                ? ` / ${cleanDisplayText(d.content).replace(/\s+/g, " ").slice(0, 120)}`
                : ""
              addEventMessage("tool", `tool done: ${d.name}${summary}`, { dedupeKey: `tool-done:${d.name}:${summary}`, minIntervalMs: 250 })
              setState(s => ({
                ...s,
                dash: { ...s.dash, toolHistory: [...s.dash.toolHistory.slice(-15), { name: d.name!, status: "done" }] },
              }))
            }
            break
          }
          case "token_usage": {
            const d = ev.data as Record<string, unknown>
            const nextModel =
              typeof d.actualModel === "string"
                ? d.actualModel
                : typeof d.requestedModel === "string"
                  ? d.requestedModel
                  : undefined
            setState(s => ({
              ...s,
              modelName: nextModel ?? s.modelName,
              status: `ctx ${d.contextUsagePercent ?? "?"}% / cache ${d.cacheHitRate ?? "?"}% / r${d.round ?? "?"}`,
              telemetry: formatTelemetryLine(d, nextModel),
              dash: {
                ...s.dash,
                round: (d.round as number) ?? s.dash.round,
                contextTokens: (d.inputTokens as number) ?? s.dash.contextTokens,
                contextMax: (d.contextMax as number) ?? s.dash.contextMax,
                cacheHitRate: (d.cacheHitRate as number) ?? s.dash.cacheHitRate,
                cacheHits: [...s.dash.cacheHits.slice(-20), (d.cacheHitRate as number) ?? 0],
              },
            }))
            break
          }
          case "plan_ready": {
            const d = ev.data as { score?: number; goal?: string; planText?: string }
            const score = typeof d?.score === "number" ? ` score ${Math.round(d.score * 100)}%` : ""
            const goal = d?.goal ? ` / ${d.goal}` : ""
            addEventMessage("plan", `plan ready${score}${goal}${d?.planText ? `\n${takeVisibleLines(compactAssistantText(d.planText), 8)}` : ""}`, { dedupeKey: `plan:${d?.goal ?? ""}:${d?.score ?? ""}`, minIntervalMs: 0 })
            break
          }
          case "clarification_ready": {
            const d = ev.data as ClarificationReady
            flush()
            const markerText = formatClarificationHistoryMarker(d)
            const visibleText = formatClarificationTranscript(d)
            assistantText = markerText
            historyRef.current = [
              ...historySnapshot,
              { role: "user", content: p },
              { role: "assistant", content: markerText },
            ]
            setClarification({
              originalPrompt: d.originalPrompt,
              questions: d.questions,
              index: 0,
              selected: recommendedOptionIndex(d.questions[0]),
              answers: [],
              extraPrompt: d.extraPrompt,
              rawText: d.rawText,
            })
            setState(s => ({
              ...s,
              status: "clarification needed",
              done: true,
              messages: s.messages.map(message =>
                message.id === assistantId
                  ? { ...message, content: visibleText, pending: false }
                  : message,
              ),
            }))
            return
          }
          case "error":
            if (typeof ev.data === "string") {
              const errorText = cleanAgentError(ev.data as string)
              setState(s => ({ ...s, error: errorText }))
              addEventMessage("error", errorText, { dedupeKey: `error:${errorText}`, minIntervalMs: 0 })
            }
            break
        }
      }
      flush()
      historyRef.current = [
        ...historySnapshot,
        { role: "user", content: p },
        ...(assistantText.trim() ? [{ role: "assistant" as const, content: compactAssistantText(assistantText) }] : []),
      ]
      setState(s => ({
        ...s,
        done: true,
        status: "done",
        messages: s.messages.map(message =>
          message.id === assistantId ? { ...message, pending: false } : message,
        ),
      }))
    })().catch(error => {
      const message = error instanceof Error ? error.message : String(error)
      setState(s => ({
        ...s,
        error: message,
        done: true,
        messages: s.messages.map(item =>
          item.id === assistantId
            ? { ...item, content: item.content || message, pending: false, error: true }
            : item,
        ),
      }))
    })

    return () => { cancelled = true }
  }, [apiKey, addEventMessage])

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

  const submit = useCallback((newPrompt: string) => {
    const command = newPrompt.trim()
    if (command.startsWith("/")) {
      const [name = ""] = command.slice(1).split(/\s+/, 1)
      if (name === "exit" || name === "quit") {
        process.exit(0)
      }
      if (name === "clear") {
        historyRef.current = []
        setClarification(null)
        setState({
          ...initialState(),
          status: "ready",
          done: true,
        })
        return
      }
      if (name === "help") {
        addSystemMessage(SLASH_COMMANDS.map(cmd => `/${cmd.name}${cmd.usage ? ` ${cmd.usage}` : ""}  ${cmd.description}`).join("\n"))
        return
      }
      if (name === "stats") {
        addSystemMessage(`messages ${historyRef.current.length} / model ${process.env.DEEPSEEK_MODEL_OVERRIDE ?? "deepseek-v4-pro"}`)
        return
      }
    }

    runAgent(newPrompt)
  }, [addSystemMessage, runAgent])

  useEffect(() => {
    if (!prompt?.trim()) return
    return runAgent(prompt)
  }, [prompt, runAgent])

  return { state, submit, clarification, answerClarification, moveClarificationSelection, cancelClarification }
}

function StatusMark({ done, error, tick }: { done: boolean; error: string; tick: number }) {
  if (error) return <Text color={C.red}>error</Text>
  if (done) return <Text color={C.green}>done</Text>
  return <Text color={C.cyan}>{[".", "o", "O", "o"][tick % 4]} working</Text>
}

function SonarLine({ tick, width, active }: { tick: number; width: number; active: boolean }) {
  const usable = Math.max(24, Math.min(width, 120))
  const head = tick % usable
  const line = Array.from({ length: usable }, (_, index) => {
    if (!active) return "-"
    const distance = Math.abs(index - head)
    if (distance === 0) return "*"
    if (distance <= 2) return "="
    if ((index + tick) % 19 === 0) return "."
    return "-"
  }).join("")

  return <Text color={C.border}>{line}</Text>
}

function FlowLine({ tick, width, active }: { tick: number; width: number; active: boolean }) {
  const usable = Math.max(18, Math.min(width, 72))
  const head = tick % usable
  const line = Array.from({ length: usable }, (_, index) => {
    if (!active) return "-"
    const distance = Math.abs(index - head)
    if (distance === 0) return "*"
    if (distance <= 2) return "="
    if ((index + tick) % 13 === 0) return "."
    return "-"
  }).join("")

  return <Text color={active ? C.cyan : C.border}>{line}</Text>
}

function EmptySurface() {
  return (
    <Box flexDirection="column">
      <Text color={C.cyan} bold>DeepSeek Code</Text>
      <Text color={C.dim}>Hraness runtime is ready. Start with a request or type / for commands.</Text>
      <Box height={1} />
      <Text color={C.blue}>status <Text color={C.dim}>/</Text> ready</Text>
      <Text color={C.dim}>model {process.env.DEEPSEEK_MODEL_OVERRIDE ?? "deepseek-v4-pro"} / evidence before done</Text>
    </Box>
  )
}

function fitText(text: string, width: number): string {
  return fitTerminalText(text, width)
}

function compactAssistantText(text: string): string {
  return text
    .trim()
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s*[-*]\s+/gm, "- ")
}

function appendAssistantText(current: string, chunk: string): string {
  const next = current + chunk
  const maxLiveChars = Number(process.env.DEEPSEEK_TUI_LIVE_CHARS ?? "12000")
  if (next.length <= maxLiveChars) return next
  return `...[live output trimmed ${next.length - maxLiveChars} chars]\n${next.slice(-maxLiveChars)}`
}

function modelNameFromUsage(data: Record<string, unknown>): string {
  if (typeof data.actualModel === "string") return data.actualModel
  if (typeof data.requestedModel === "string") return data.requestedModel
  return "unknown-model"
}

function formatTelemetryLine(data: Record<string, unknown>, modelName?: string): string {
  const model = modelName ?? modelNameFromUsage(data)
  return `model ${model} / ctx ${data.contextUsagePercent ?? "?"}% / cache ${data.cacheHitRate ?? "?"}% / round ${data.round ?? "?"}`
}

function formatClarificationHistoryMarker(data: ClarificationReady): string {
  return [
    CLARIFICATION_MARKER,
    "Clarification requested. The TUI is collecting answers one question at a time.",
    `Original request: ${data.originalPrompt}`,
  ].join("\n")
}

function formatClarificationTranscript(data: ClarificationReady): string {
  return `I need ${data.questions.length} clarification answers before implementation. Use the selector below.`
}

function cleanAgentError(text: string): string {
  if (text.includes(CLARIFICATION_MARKER)) {
    return "Clarification failed. Please add a little more detail and try again."
  }
  return text
}

function synthesizeClarificationAnswer(wizard: ClarificationWizardState): string {
  const lines = [
    "Clarification answers:",
    ...wizard.answers.map((answer, index) => `${index + 1}. ${answer.question}: ${answer.key}. ${answer.label}`),
  ]
  lines.push("Extra: none")
  return lines.join("\n")
}

function recommendedOptionIndex(question: ClarificationQuestion | undefined): number {
  if (!question?.options.length) return 0
  const recommended = question.options.findIndex(option => option.recommended)
  return recommended >= 0 ? recommended : 0
}

function compactStatusText(status: string): string {
  if (/^context-kernel:/i.test(status)) return "context ready"
  if (/^thinking-compaction:/i.test(status)) return "memory compacted"
  if (/^ctx\s/i.test(status)) return status
  if (status === "working") return "working"
  return status
}

function takeVisibleLines(text: string, maxLines: number): string {
  return text.split("\n").slice(0, maxLines).join("\n")
}

function renderMessageLines(message: ChatMessage, width: number, tick: number, status: string): Array<{ marker: string; text: string; color: string }> {
  const contentWidth = Math.max(12, width - 4)
  const marker = message.role === "user" ? ">" : message.role === "event" ? eventMarker(message.kind) : "|"
  const color = message.role === "user" ? C.cyan : message.role === "event" ? eventColor(message.kind) : message.error ? C.red : C.blue
  const tail = ["", ".", "..", "..."][tick % 4] ?? ""

  if (message.role === "user") {
    const userText = cleanDisplayText(trimForViewport(message.content, Math.max(240, width * 5)))
    return formatDisplayText(userText, contentWidth).map((line, index) => ({ marker: index === 0 ? marker : " ", text: line, color }))
  }

  if (message.role === "event") {
    const eventText = cleanDisplayText(trimForViewport(message.content, Math.max(360, Math.min(1800, width * 18))))
    return formatDisplayText(eventText, contentWidth).map((line, index) => ({ marker: index === 0 ? marker : " ", text: line, color }))
  }

  if (message.content) {
    const assistantText = `${cleanDisplayText(trimForViewport(message.content, Math.max(1200, Math.min(5000, width * 42))))}${message.pending ? tail : ""}`
    return formatDisplayText(assistantText, contentWidth).map((line, index) => ({ marker: index === 0 ? marker : " ", text: line, color }))
  }

  if (message.pending) {
    const verb = ["thinking", "routing", "reading", "checking"][tick % 4]
    const statusText = `${verb}${status ? ` / ${status}` : ""}`
    const line = Array.from({ length: Math.max(18, Math.min(contentWidth, 72)) }, (_, index) => {
      const head = tick % Math.max(18, Math.min(contentWidth, 72))
      const distance = Math.abs(index - head)
      if (distance === 0) return "*"
      if (distance <= 2) return "="
      if ((index + tick) % 13 === 0) return "."
      return "-"
    }).join("")
    return [
      { marker, text: statusText, color },
      { marker: " ", text: line, color: C.cyan },
    ]
  }

  return []
}

function eventMarker(kind?: ChatEventKind): string {
  if (kind === "tool") return "$"
  if (kind === "task") return "#"
  if (kind === "plan") return "+"
  if (kind === "error") return "!"
  return "-"
}

function eventColor(kind?: ChatEventKind): string {
  if (kind === "tool") return C.green
  if (kind === "task") return C.blue
  if (kind === "plan") return C.cyan
  if (kind === "error") return C.red
  return C.dim
}

function ChatTranscript({ messages, width, height, tick, status, scrollOffset, onScrollState }: { messages: ChatMessage[]; width: number; height: number; tick: number; status: string; scrollOffset: number; onScrollState?: (state: TranscriptScrollState) => void }) {
  const animatedTick = messages.some(message => message.pending) ? tick : 0
  const lines = useMemo(() => {
    const next = messages.flatMap(message => [
      ...renderMessageLines(message, width, animatedTick, status),
      { marker: " ", text: "", color: C.dim },
    ])
    if (next.length > 0 && next[next.length - 1]?.text === "") next.pop()
    return next
  }, [animatedTick, messages, status, width])

  const maxOffset = Math.max(0, lines.length - height)
  const normalizedOffset = Math.min(scrollOffset, maxOffset)
  const start = Math.max(0, lines.length - height - normalizedOffset)
  const visibleLines = lines.slice(start, start + height)
  const hiddenAbove = start > 0
  const hiddenBelow = start + height < lines.length

  useEffect(() => {
    onScrollState?.({ maxOffset, normalizedOffset, hiddenAbove, hiddenBelow })
  }, [hiddenAbove, hiddenBelow, maxOffset, normalizedOffset, onScrollState])

  if (messages.length === 0) return null

  return (
    <Box flexDirection="column">
      {hiddenAbove && <Text color={C.dim}>  ... earlier messages (Up/PageUp)</Text>}
      {visibleLines.slice(hiddenAbove ? 1 : 0, hiddenBelow ? Math.max(0, visibleLines.length - 1) : visibleLines.length).map((line, index) => (
        <Box key={`${start}-${index}`} flexDirection="row">
          <Box width={3}>
            <Text color={line.color}>{line.marker}</Text>
          </Box>
          <Text color={line.color === C.red ? C.red : C.white}>{line.text}</Text>
        </Box>
      ))}
      {hiddenBelow && <Text color={C.dim}>  ... newer messages (Down/PageDown)</Text>}
    </Box>
  )
}

function TaskProgressStrip({ task, width, tick }: { task: TaskProgressState | null; width: number; tick: number }) {
  if (!task || task.total === 0) return null

  if (task.phase === "planning") {
    const pulse = ["thinking", "checking scope", "waiting for plan", "planning gate"][tick % 4]
    return (
      <Box flexDirection="column" paddingX={1} marginBottom={1}>
        <Text color={C.cyan}>planning / <Text color={C.dim}>{pulse}</Text></Text>
        <Text color={C.dim}>{fitText(task.goal, Math.max(18, width - 4))}</Text>
        <FlowLine tick={tick} width={Math.max(18, width - 4)} active />
        <Text color={C.dim}>The model has not produced an accepted plan yet. Checklist will appear after planning gate passes.</Text>
      </Box>
    )
  }

  const running = task.steps.filter(step => step.status === "running").length
  const open = task.steps.filter(step => step.status === "pending").length
  const visible = task.steps.slice(0, 4)
  const extra = Math.max(0, task.steps.length - visible.length)

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Text color={C.dim}>
        {task.total} tasks ({task.done} done, {running} in progress, {open} open) <Text color={C.blue}>{task.phase}</Text>
      </Text>
      {visible.map(step => (
        <Text key={step.id} color={step.status === "done" ? C.green : step.status === "running" ? C.cyan : step.status === "failed" ? C.red : C.dim}>
          {step.status === "done" ? "[x]" : step.status === "running" ? "[>]" : step.status === "failed" ? "[!]" : "[ ]"} {fitText(step.title, Math.max(18, width - 8))}
        </Text>
      ))}
      {extra > 0 && <Text color={C.dim}>... +{extra} more</Text>}
    </Box>
  )
}

function ClarificationPanel({ wizard, width, tick }: { wizard: ClarificationWizardState; width: number; tick: number }) {
  const question = wizard.questions[wizard.index]
  if (!question) return null
  const flowWidth = Math.max(18, Math.min(width - 4, 72))

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Box flexDirection="row">
        <Text color={C.cyan}>clarify </Text>
        <Text color={C.dim}>{wizard.index + 1}/{wizard.questions.length}</Text>
        <Text color={C.dim}> / choose one</Text>
      </Box>
      <Text color={C.white}>{fitText(question.title, Math.max(18, width - 4))}</Text>
      {question.options.map((option, index) => {
        const selected = index === wizard.selected
        return (
          <Box key={`${question.id}-${option.key}`} flexDirection="row">
            <Box width={3}>
              <Text color={selected ? C.cyan : C.dim}>{selected ? ">" : " "}</Text>
            </Box>
            <Box width={4}>
              <Text color={selected ? C.cyan : C.blue}>{option.key}.</Text>
            </Box>
            <Text color={selected ? C.white : C.dim}>
              {fitText(option.label, Math.max(18, width - 12))}
              {option.recommended ? " [recommended]" : ""}
            </Text>
          </Box>
        )
      })}
      <FlowLine tick={tick} width={flowWidth} active />
      <Text color={C.dim}>Up/Down or j/k select  Enter confirm  Esc cancel</Text>
    </Box>
  )
}

export function ChatApp({ prompt, apiKey }: { prompt?: string; apiKey: string }) {
  const { stdout } = useStdout()
  const rows = Math.max(24, stdout.rows ?? 32)
  const cols = stdout.columns ?? 96
  const { state, submit, clarification, answerClarification, moveClarificationSelection, cancelClarification } = useAgentStream(apiKey, prompt)
  const [tick, setTick] = useState(0)
  const [scrollOffset, setScrollOffset] = useState(0)
  const [scrollState, setScrollState] = useState<TranscriptScrollState>({ maxOffset: 0, normalizedOffset: 0, hiddenAbove: false, hiddenBelow: false })
  const [autoFollow, setAutoFollow] = useState(true)
  const [showStartup, setShowStartup] = useState(process.env.DEEPSEEK_TUI_SPLASH !== "off")
  const mouseScrollEnabled = process.env.DEEPSEEK_TUI_MOUSE !== "off"
  const footerHeight = clarification ? 12 : state.task ? 11 : 6
  const bodyHeight = Math.max(10, rows - footerHeight - 3)
  const isWorking = !state.done && !state.error
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
    const animated = showStartup || isWorking || Boolean(clarification) || state.task?.phase === "planning"
    if (!animated) return
    const timer = setInterval(() => setTick(n => n + 1), isWorking ? TUI_FRAME_MS : Math.max(TUI_FRAME_MS, 500))
    return () => clearInterval(timer)
  }, [clarification, isWorking, showStartup, state.task?.phase])

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
    if (_input === "k") {
      scrollUp(1)
      return
    }
    if (_input === "j") {
      scrollDown(1)
      return
    }
    if (key.ctrl && _input === "u") {
      scrollUp(Math.max(3, bodyHeight - 4))
      return
    }
    if (key.ctrl && _input === "d") {
      scrollDown(Math.max(3, bodyHeight - 4))
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

  const hasDash = state.dash.round > 0 || state.dash.toolHistory.length > 0
  const showDash = hasDash && cols >= 110
  if (showStartup) {
    return (
      <Box height={rows} paddingX={1} flexDirection="column">
        <TuiInputGuard />
        <Box flexGrow={1}>
          <InkStartupScreen
            version="0.3.0"
            toolsCount={24}
            thinkingEffort="auto"
            modelName={state.modelName}
          />
        </Box>
      </Box>
    )
  }

  const empty = state.messages.length === 0 && state.done && !prompt?.trim()

  return (
    <Box flexDirection="column" height={rows} paddingX={1}>
      <TuiInputGuard />
      <Box height={2} flexDirection="column">
        <Box flexDirection="row">
          <Text color={C.cyan} bold>DeepSeek Code</Text>
          <Text color={C.dim}> / hraness / </Text>
          <Text color={C.blue}>model {state.modelName}</Text>
          <Text color={C.dim}> / </Text>
          <StatusMark done={state.done} error={state.error} tick={tick} />
          <Text color={C.dim}>{state.status ? ` / ${state.status}` : ""}</Text>
        </Box>
        <SonarLine tick={tick} width={cols} active={isWorking} />
      </Box>

      <Box flexDirection="row" height={bodyHeight} flexGrow={1}>
        <Box flexDirection="column" flexGrow={1} marginRight={1}>
          <Text color={C.dim}>
            {state.messages.length > 0
              ? `history ${state.messages.length} messages / follow-up context on${scrollState.maxOffset > 0 ? ` / scroll ${scrollState.normalizedOffset}/${scrollState.maxOffset}` : ""}`
              : `Prompt: ${prompt?.slice(0, 100) ?? ""}`}
          </Text>
          <Box height={1} />
          <Box flexDirection="column" flexGrow={1}>
            {empty ? (
              <EmptySurface />
            ) : (
              <ChatTranscript
                messages={state.messages}
                width={cols - (showDash ? 44 : 2)}
                height={Math.max(4, bodyHeight - 3)}
                tick={tick}
                status={state.status}
                scrollOffset={scrollOffset}
                onScrollState={setScrollState}
              />
            )}
          </Box>
          {state.error && <Text color={C.red}>{state.error}</Text>}
        </Box>

        {showDash && (
          <Box width={42}>
            <Dashboard {...state.dash} />
          </Box>
        )}
      </Box>

      <Box flexDirection="column" minHeight={footerHeight} marginTop={1}>
        {clarification ? (
          <ClarificationPanel wizard={clarification} width={cols} tick={tick} />
        ) : (
          <TaskProgressStrip task={state.task} width={cols} tick={tick} />
        )}
        <InputLine
          onSubmit={submitFromInput}
          disabled={!state.done || Boolean(clarification)}
          placeholder={clarification ? "Use the selector above..." : state.done ? "Ask a follow-up..." : "DeepSeek Code is working..."}
          status={state.status}
          commands={SLASH_COMMANDS}
          focused={state.done && !clarification}
          onScrollUp={() => scrollUp(3)}
          onScrollDown={() => scrollDown(3)}
        />
        <Box paddingX={1}>
          <Text color={C.dim}>
            {state.telemetry || `model ${state.modelName} / ctx 0% / cache 0% / round 0`}  scroll: {mouseScrollEnabled ? "wheel, " : ""}k/j, PgUp/PgDn · {autoFollow ? "auto" : "manual"}
          </Text>
        </Box>
      </Box>
    </Box>
  )
}

export function startInkTUI(prompt?: string) {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    console.error("DEEPSEEK_API_KEY not set")
    process.exit(1)
  }
  const { waitUntilExit } = render(<ChatApp prompt={prompt} apiKey={apiKey} />)
  return waitUntilExit()
}
