import React, { useMemo, useState } from "react"
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
  commands?: SlashCommandHint[]
  focused?: boolean
  onScrollUp?: () => void
  onScrollDown?: () => void
}

function isIgnorableInput(input: string): boolean {
  if (!input) return false
  if (input.startsWith("\x1b[")) return true
  if (input.includes("\x1b")) return true
  if (/^\[<\d+;\d+;\d+[mM]$/.test(input)) return true
  if (/^\[<\d+;/.test(input) && /[mM]$/.test(input) && input.includes(";")) return true
  return false
}

function insertText(value: string, cursor: number, text: string): { value: string; cursor: number } {
  const next = value.slice(0, cursor) + text + value.slice(cursor)
  return { value: next, cursor: cursor + text.length }
}

function sanitizePrintableInput(input: string): string {
  return input
    .replace(/\r/g, "")
    .replace(/\n/g, "")
    .replace(/[\x00-\x1F\x7F]/g, "")
}

export function InputLine({ onSubmit, disabled, placeholder, status, commands = [], focused = true, onScrollUp, onScrollDown }: Props) {
  const [value, setValue] = useState("")
  const [cursor, setCursor] = useState(0)
  const [history, setHistory] = useState<string[]>([])
  const [historyIdx, setHistoryIdx] = useState(-1)
  const [commandIdx, setCommandIdx] = useState(0)

  const slashQuery = value.trimStart().startsWith("/") ? value.trimStart().slice(1).split(/\s+/)[0] ?? "" : ""
  const showCommands = !disabled && value.trimStart().startsWith("/")
  const commandMatches = commands
    .filter(command => command.name.startsWith(slashQuery))
    .slice(0, 5)
  const selectedCommand = commandMatches[Math.min(commandIdx, Math.max(0, commandMatches.length - 1))]
  const cursorVisible = focused && !disabled
  const displayCursor = cursorVisible ? Math.min(cursor, value.length) : -1

  useInput((input, key) => {
    const isRecognizedControlKey = Boolean(
      key.upArrow ||
        key.downArrow ||
        key.leftArrow ||
        key.rightArrow ||
        key.home ||
        key.end ||
        key.backspace ||
        key.delete ||
        key.tab ||
        key.return ||
        key.escape ||
        key.pageUp ||
        key.pageDown ||
        key.ctrl ||
        key.meta,
    )
    if (isIgnorableInput(input) && !isRecognizedControlKey) return
    const canEdit = focused && !disabled
    const setHistoryValue = (nextValue: string) => {
      setHistoryIdx(-1)
      setCommandIdx(0)
      setValue(nextValue)
      setCursor(nextValue.length)
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
        } else {
          setHistoryIdx(newIdx)
          setValue(history[newIdx]!)
          setCursor(history[newIdx]!.length)
        }
      }
      return
    }

    if (key.leftArrow) {
      if (canEdit) setCursor(pos => Math.max(0, pos - 1))
      return
    }

    if (key.rightArrow) {
      if (canEdit) setCursor(pos => Math.min(value.length, pos + 1))
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
      setValue(prev => prev.slice(0, cursor - 1) + prev.slice(cursor))
      setCursor(pos => Math.max(0, pos - 1))
      return
    }

    if (key.delete) {
      if (!canEdit || cursor >= value.length) return
      setHistoryIdx(-1)
      setCommandIdx(0)
      setValue(prev => prev.slice(0, cursor) + prev.slice(cursor + 1))
      return
    }

    if (key.tab) {
      if (canEdit && showCommands && selectedCommand && !/\s/.test(value.trimStart().slice(1))) {
        const next = `/${selectedCommand.name}`
        setValue(next)
        setCursor(next.length)
        setHistoryIdx(-1)
        setCommandIdx(0)
      }
      return
    }

    if (key.return) {
      if (canEdit) submitValue(value)
      return
    }

    const printableInput = sanitizePrintableInput(input)
    if (canEdit && printableInput) {
      setHistoryIdx(-1)
      setCommandIdx(0)
      setValue(prev => {
        const next = insertText(prev, cursor, printableInput)
        setCursor(next.cursor)
        return next.value
      })
    }
  }, { isActive: focused || disabled || Boolean(onScrollUp || onScrollDown) })

  const submitValue = (raw: string) => {
    const rawTrimmed = raw.trim()
    const commandText = rawTrimmed.slice(1)
    const hasCommandArgs = rawTrimmed.startsWith("/") && /\s/.test(commandText)
    const trimmed = showCommands && selectedCommand && !hasCommandArgs ? `/${selectedCommand.name}` : rawTrimmed
    if (!trimmed) return
    setHistory(h => [...h.slice(-50), trimmed])
    setHistoryIdx(-1)
    setCommandIdx(0)
    onSubmit(trimmed)
    setValue("")
    setCursor(0)
  }

  const muted = !value
  const renderedInput = useMemo(() => {
    if (!cursorVisible) return value || ""
    const before = value.slice(0, displayCursor)
    const after = value.slice(displayCursor)
    const current = after.slice(0, 1) || " "
    return { before, current, after: after.slice(1) }
  }, [cursorVisible, displayCursor, value])

  return (
    <Box flexDirection="column">
      {showCommands && (
        <Box flexDirection="column" marginBottom={1} paddingX={1}>
          {commandMatches.length === 0 ? (
            <Text color={C.dim}>No slash command matches.</Text>
          ) : commandMatches.map((command, index) => (
            <Box key={command.name} flexDirection="row">
              <Box width={2}>
                <Text color={index === commandIdx ? C.cyan : C.dim}>{index === commandIdx ? ">" : " "}</Text>
              </Box>
              <Box width={18}>
                <Text color={index === commandIdx ? C.cyan : C.blue}>/{command.name}</Text>
              </Box>
              <Text color={index === commandIdx ? C.fg : C.dim}>{command.description}{command.usage ? `  ${command.usage}` : ""}</Text>
            </Box>
          ))}
        </Box>
      )}

      <Box flexDirection="column" borderStyle="single" borderColor={disabled ? C.border : C.cyan} paddingX={1}>
        <Box flexDirection="row">
          <Text color={disabled ? C.dim : C.cyan}>{"> "}</Text>
          {disabled ? (
            <Text color={C.dim}>{placeholder || "DeepSeek Code is working..."}</Text>
          ) : (
            <Box flexGrow={1}>
              {typeof renderedInput === "string" ? (
                <Text color={muted ? C.dim : C.fg}>{renderedInput || (placeholder || "Message DeepSeek Code...")}</Text>
              ) : (
                <Text color={C.fg}>
                  {renderedInput.before}
                  <Text inverse color={C.cyan}>{renderedInput.current}</Text>
                  {renderedInput.after}
                </Text>
              )}
              {cursorVisible && value.length === 0 && !renderedInput ? (
                <Text color={C.dim}>{placeholder || "Message DeepSeek Code..."}</Text>
              ) : null}
            </Box>
          )}
        </Box>
        <Box>
          <Text color={disabled ? C.yellow : C.dim}>
            {disabled ? (status || "working...") : showCommands ? "Up/Down select  Enter send command" : "Enter send  / commands  Up/Down scroll · wheel supported"}
          </Text>
        </Box>
      </Box>
    </Box>
  )
}
