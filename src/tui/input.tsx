import React, { useEffect, useMemo, useRef, useState } from "react"
import { Box, Text, useInput } from "ink"

const C = {
  cyan: "#38BDF8",
  blue: "#60A5FA",
  border: "#334155",
  dim: "#64748B",
  fg: "#E5E7EB",
  yellow: "#F59E0B",
}

export interface SlashCommandHint {
  name: string
  description: string
  usage?: string
}

interface Props {
  onSubmit: (value: string) => void
  disabled?: boolean
  placeholder?: string
  status?: string
  rightStatus?: string
  commands?: SlashCommandHint[]
  focused?: boolean
  onScrollUp?: () => void
  onScrollDown?: () => void
  onChromeChange?: (state: { commandOpen: boolean; pasteCount: number }) => void
}

interface PasteBlock {
  id: number
  token: string
  text: string
  lines: number
  chars: number
}

const PASTE_PREFIX = "PASTE:"
const PASTE_SUFFIX = ""
const pasteTokenRegex = /PASTE:(\d+)/g
const pasteTriggerChars = Number(process.env.DEEPSEEK_TUI_PASTE_CHARS ?? "800")
const pasteTriggerLines = Number(process.env.DEEPSEEK_TUI_PASTE_LINES ?? "2")
const inputDisplayChars = Number(process.env.DEEPSEEK_TUI_INPUT_DISPLAY_CHARS ?? "260")

function pasteToken(id: number): string {
  return `${PASTE_PREFIX}${id}${PASTE_SUFFIX}`
}

function countLines(text: string): number {
  if (!text) return 0
  return text.split("\n").length
}

function normalizePastedText(input: string): string {
  return input
    .replace(/\x1b\[200~/g, "")
    .replace(/\x1b\[201~/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
}

function sanitizeInlineInput(input: string): string {
  return input
    .replace(/\x1b\[200~/g, "")
    .replace(/\x1b\[201~/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[\x00-\x1F\x7F]/g, "")
}

function isMouseSequence(input: string): boolean {
  if (!input) return false
  if (/^\x1b\[<\d+;\d+;\d+[mM]$/.test(input)) return true
  if (/^\x1b\[M/.test(input)) return true
  if (/^\[<\d+;\d+;\d+[mM]$/.test(input)) return true
  return false
}

function isUnhandledEscapeSequence(input: string): boolean {
  if (!input.includes("\x1b")) return false
  if (input.includes("\x1b[200~") || input.includes("\x1b[201~")) return false
  return true
}

function insertText(value: string, cursor: number, text: string): { value: string; cursor: number } {
  const next = value.slice(0, cursor) + text + value.slice(cursor)
  return { value: next, cursor: cursor + text.length }
}

function labelForPaste(block: PasteBlock): string {
  const linePart = block.lines > 1 ? ` +${block.lines} lines` : ""
  return `[Pasted text #${block.id}${linePart}, ${block.chars} chars loaded]`
}

function displayDraft(value: string, blocks: PasteBlock[]): string {
  const byId = new Map(blocks.map(block => [String(block.id), block]))
  return value.replace(pasteTokenRegex, (_token, id: string) => {
    const block = byId.get(id)
    return block ? labelForPaste(block) : `[Pasted text #${id}]`
  })
}

function expandDraft(value: string, blocks: PasteBlock[]): string {
  const byId = new Map(blocks.map(block => [String(block.id), block]))
  return value.replace(pasteTokenRegex, (_token, id: string) => byId.get(id)?.text ?? "")
}

function hasPasteToken(value: string): boolean {
  pasteTokenRegex.lastIndex = 0
  return pasteTokenRegex.test(value)
}

function previousCursor(value: string, cursor: number): number {
  if (cursor <= 0) return 0
  for (const match of value.matchAll(pasteTokenRegex)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    if (cursor > start && cursor <= end) return start
  }
  return cursor - 1
}

function nextCursor(value: string, cursor: number): number {
  if (cursor >= value.length) return value.length
  for (const match of value.matchAll(pasteTokenRegex)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    if (cursor >= start && cursor < end) return end
  }
  return cursor + 1
}

function deleteBeforeCursor(value: string, cursor: number): { value: string; cursor: number } {
  const nextCursorPosition = previousCursor(value, cursor)
  return {
    value: value.slice(0, nextCursorPosition) + value.slice(cursor),
    cursor: nextCursorPosition,
  }
}

function deleteAfterCursor(value: string, cursor: number): string {
  if (cursor >= value.length) return value
  const nextCursorPosition = nextCursor(value, cursor)
  return value.slice(0, cursor) + value.slice(nextCursorPosition)
}

function displayWindow(text: string, cursor: number): { text: string; cursor: number } {
  const limit = Math.max(80, inputDisplayChars)
  if (text.length <= limit) return { text, cursor }

  const leftRoom = Math.floor(limit * 0.62)
  const start = Math.max(0, Math.min(cursor - leftRoom, text.length - limit))
  const end = Math.min(text.length, start + limit)
  const prefix = start > 0 ? "…" : ""
  const suffix = end < text.length ? "…" : ""
  return {
    text: `${prefix}${text.slice(start, end)}${suffix}`,
    cursor: Math.max(0, Math.min(prefix.length + cursor - start, prefix.length + end - start)),
  }
}

function shouldStagePaste(text: string): boolean {
  if (!text) return false
  const lines = countLines(text)
  return lines >= pasteTriggerLines || text.length >= pasteTriggerChars
}

export function InputLine({
  onSubmit,
  disabled,
  placeholder,
  status,
  rightStatus,
  commands = [],
  focused = true,
  onScrollUp,
  onScrollDown,
  onChromeChange,
}: Props) {
  const [value, setValue] = useState("")
  const [cursor, setCursor] = useState(0)
  const [history, setHistory] = useState<string[]>([])
  const [historyIdx, setHistoryIdx] = useState(-1)
  const [commandIdx, setCommandIdx] = useState(0)
  const [pasteBlocks, setPasteBlocks] = useState<PasteBlock[]>([])
  const [nextPasteId, setNextPasteId] = useState(1)
  const pasteSessionRef = useRef<{ startValue: string; startCursor: number; accumulated: string } | null>(null)
  const pasteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const nextPasteIdRef = useRef(1)
  nextPasteIdRef.current = nextPasteId

  const visibleDraft = useMemo(() => displayDraft(value, pasteBlocks), [pasteBlocks, value])
  const expandedDraft = useMemo(() => expandDraft(value, pasteBlocks), [pasteBlocks, value])
  const commandDraft = hasPasteToken(value) ? "" : visibleDraft
  const slashQuery = commandDraft.trimStart().startsWith("/") ? commandDraft.trimStart().slice(1).split(/\s+/)[0] ?? "" : ""
  const showCommands = !disabled && commandDraft.trimStart().startsWith("/")
  const commandMatches = commands
    .filter(command => command.name.startsWith(slashQuery))
    .slice(0, 3)
  const selectedCommand = commandMatches[Math.min(commandIdx, Math.max(0, commandMatches.length - 1))]
  const cursorVisible = focused && !disabled

  const stagePaste = (text: string) => {
    const normalized = normalizePastedText(text)
    if (!normalized) return
    const id = nextPasteId
    const token = pasteToken(id)
    const block: PasteBlock = {
      id,
      token,
      text: normalized,
      lines: countLines(normalized),
      chars: normalized.length,
    }
    setNextPasteId(id + 1)
    setPasteBlocks(blocks => [...blocks, block])
    setHistoryIdx(-1)
    setCommandIdx(0)
    setValue(prev => {
      const next = insertText(prev, cursor, token)
      setCursor(next.cursor)
      return next.value
    })
  }

  const clearPasteBuffer = () => {
    if (pasteTimerRef.current) {
      clearTimeout(pasteTimerRef.current)
      pasteTimerRef.current = null
    }
    pasteSessionRef.current = null
  }

  const flushPasteBuffer = () => {
    const session = pasteSessionRef.current
    pasteSessionRef.current = null
    pasteTimerRef.current = null
    if (!session) return
    const normalized = normalizePastedText(session.accumulated)
    if (!normalized || !shouldStagePaste(normalized)) return
    const id = nextPasteIdRef.current
    const token = pasteToken(id)
    const block: PasteBlock = {
      id,
      token,
      text: normalized,
      lines: countLines(normalized),
      chars: normalized.length,
    }
    setNextPasteId(n => n + 1)
    setPasteBlocks(blocks => [...blocks, block])
    setValue(session.startValue.slice(0, session.startCursor) + token + session.startValue.slice(session.startCursor))
    setCursor(session.startCursor + token.length)
    setHistoryIdx(-1)
    setCommandIdx(0)
  }

  const setHistoryValue = (nextValue: string) => {
    setPasteBlocks([])
    setHistoryIdx(-1)
    setCommandIdx(0)
    setValue(nextValue)
    setCursor(nextValue.length)
  }

  const submitValue = (raw: string) => {
    const rawTrimmed = raw.trim()
    const commandText = rawTrimmed.slice(1)
    const hasCommandArgs = rawTrimmed.startsWith("/") && /\s/.test(commandText)
    const expandedTrimmed = expandedDraft.trim()
    const trimmed = showCommands && selectedCommand && !hasCommandArgs ? `/${selectedCommand.name}` : expandedTrimmed
    if (!trimmed) return

    const historyLabel = displayDraft(value, pasteBlocks).trim()
    setHistory(h => [...h.slice(-50), historyLabel || trimmed.slice(0, 240)])
    setHistoryIdx(-1)
    setCommandIdx(0)
    onSubmit(trimmed)
    setValue("")
    setCursor(0)
    setPasteBlocks([])
  }

  useInput((input, key) => {
    const canEdit = focused && !disabled

    if (isMouseSequence(input)) return
    if (isUnhandledEscapeSequence(input) && !(key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.pageUp || key.pageDown || key.home || key.end || key.backspace || key.delete || key.return || key.tab || key.escape)) return

    // Single-chunk paste staging (fast path) — skip when any control key is active,
    // otherwise Enter (\r → \n → 2 lines) falsely triggers paste detection.
    const isControlKey = key.return || key.tab || key.escape ||
      key.upArrow || key.downArrow || key.leftArrow || key.rightArrow ||
      key.backspace || key.delete || key.home || key.end ||
      key.pageUp || key.pageDown || (key.ctrl && input)
    if (canEdit && input && !isControlKey) {
      const maybePaste = normalizePastedText(input)
      if (shouldStagePaste(maybePaste)) {
        clearPasteBuffer()
        stagePaste(maybePaste)
        return
      }
    }

    // Any control key cancels pending paste accumulation
    if (canEdit && (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow ||
        key.pageUp || key.pageDown || key.home || key.end ||
        key.backspace || key.delete || key.tab || key.return || key.escape ||
        (key.ctrl && input))) {
      clearPasteBuffer()
    }

    if (key.upArrow) {
      if (!canEdit) {
        onScrollUp?.()
        return
      }
      if (showCommands && commandMatches.length > 0) {
        setCommandIdx(index => (index <= 0 ? commandMatches.length - 1 : index - 1))
        return
      }
      if (!value.trim() && onScrollUp) {
        onScrollUp()
        return
      }
      if (history.length > 0) {
        const newIdx = historyIdx === -1 ? history.length - 1 : Math.max(0, historyIdx - 1)
        setHistoryIdx(newIdx)
        setPasteBlocks([])
        setValue(history[newIdx]!)
        setCursor(history[newIdx]!.length)
      }
      return
    }

    if (key.downArrow) {
      if (!canEdit) {
        onScrollDown?.()
        return
      }
      if (showCommands && commandMatches.length > 0) {
        setCommandIdx(index => (index + 1) % commandMatches.length)
        return
      }
      if (!value.trim() && onScrollDown) {
        onScrollDown()
        return
      }
      if (historyIdx >= 0) {
        const newIdx = historyIdx + 1
        if (newIdx >= history.length) {
          setHistoryIdx(-1)
          setValue("")
          setCursor(0)
          setPasteBlocks([])
        } else {
          setHistoryIdx(newIdx)
          setPasteBlocks([])
          setValue(history[newIdx]!)
          setCursor(history[newIdx]!.length)
        }
      }
      return
    }

    if (key.leftArrow) {
      if (canEdit) setCursor(pos => previousCursor(value, pos))
      return
    }
    if (key.rightArrow) {
      if (canEdit) setCursor(pos => nextCursor(value, pos))
      return
    }
    if (key.home || (key.ctrl && input === "a")) {
      if (canEdit) setCursor(0)
      return
    }
    if (key.end || (key.ctrl && input === "e")) {
      if (canEdit) setCursor(value.length)
      return
    }
    if (key.backspace) {
      if (!canEdit || cursor <= 0) return
      setHistoryIdx(-1)
      setCommandIdx(0)
      setValue(prev => {
        const next = deleteBeforeCursor(prev, cursor)
        setCursor(next.cursor)
        return next.value
      })
      return
    }
    if (key.delete) {
      if (!canEdit || cursor >= value.length) return
      setHistoryIdx(-1)
      setCommandIdx(0)
      setValue(prev => deleteAfterCursor(prev, cursor))
      return
    }
    if (key.tab) {
      if (canEdit && showCommands && selectedCommand && !/\s/.test(commandDraft.trimStart().slice(1))) {
        const next = `/${selectedCommand.name}`
        setHistoryValue(next)
      }
      return
    }
    if (key.return) {
      if (canEdit) submitValue(value)
      return
    }

    const printableInput = sanitizeInlineInput(input)
    if (canEdit && printableInput) {
      // Accumulate rapid input for time-window paste detection
      // (handles terminals that chunk long pastes into small pieces)
      const rawText = normalizePastedText(input)
      if (!pasteSessionRef.current) {
        pasteSessionRef.current = { startValue: value, startCursor: cursor, accumulated: rawText }
      } else {
        pasteSessionRef.current.accumulated += rawText
      }
      if (pasteTimerRef.current) clearTimeout(pasteTimerRef.current)
      pasteTimerRef.current = setTimeout(flushPasteBuffer, 80)

      setHistoryIdx(-1)
      setCommandIdx(0)
      setValue(prev => {
        const next = insertText(prev, cursor, printableInput)
        setCursor(next.cursor)
        return next.value
      })
    }
  }, { isActive: focused || disabled || Boolean(onScrollUp || onScrollDown) })

  const renderedInput = useMemo(() => {
    const displayCursor = Math.min(displayDraft(value.slice(0, cursor), pasteBlocks).length, visibleDraft.length)
    const windowed = displayWindow(visibleDraft, displayCursor)
    if (!cursorVisible) return windowed.text || ""
    const before = windowed.text.slice(0, windowed.cursor)
    const after = windowed.text.slice(windowed.cursor)
    const current = after.slice(0, 1) || " "
    return { before, current, after: after.slice(1) }
  }, [cursorVisible, cursor, pasteBlocks, value, visibleDraft])

  const pasteCount = pasteBlocks.filter(block => value.includes(block.token)).length
  useEffect(() => {
    onChromeChange?.({ commandOpen: showCommands, pasteCount })
  }, [onChromeChange, pasteCount, showCommands])
  const compactInputStatus = disabled
    ? "运行中"
    : showCommands
      ? "↑/↓ 选择 · Enter 发送"
      : pasteCount > 0
        ? `已载入 ${pasteCount} 段粘贴内容 · Backspace 移除`
        : ""

  return (
    <Box flexDirection="column" paddingX={1}>
      {showCommands && (
        <Box flexDirection="column" marginBottom={1} marginLeft={2}>
          {commandMatches.length === 0 ? (
            <Text color={C.dim}>无匹配命令</Text>
          ) : commandMatches.map((command, index) => (
            <Text key={command.name} color={index === commandIdx ? C.cyan : C.dim}>
              {index === commandIdx ? ">" : " "} /{command.name} <Text color={C.dim}>{command.description}</Text>
            </Text>
          ))}
        </Box>
      )}
      <Box flexDirection="row" alignItems="center">
        <Text color={showCommands || pasteCount > 0 ? C.cyan : C.border}>|</Text>
        <Text color={C.cyan}> › </Text>
        {disabled ? (
          <Text color={C.dim}>{placeholder || "Orcana is working..."}</Text>
        ) : typeof renderedInput === "string" ? (
          <Text color={renderedInput ? C.fg : C.dim}>{renderedInput || (placeholder || "Message Orcana...")}</Text>
        ) : (
          <Text>
            <Text color={C.fg}>{renderedInput.before}</Text>
            <Text inverse color={C.fg}>{renderedInput.current}</Text>
            <Text color={C.fg}>{renderedInput.after}</Text>
          </Text>
        )}
        {rightStatus && !showCommands && (
          <Box flexGrow={1} justifyContent="flex-end">
            <Text color={C.dim}>{rightStatus}</Text>
          </Box>
        )}
      </Box>
      {compactInputStatus && (
        <Box marginLeft={2}>
          <Text color={pasteCount > 0 ? C.yellow : C.dim}>{compactInputStatus}</Text>
        </Box>
      )}
    </Box>
  )
}
