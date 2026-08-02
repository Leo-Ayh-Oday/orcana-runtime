import React, { useState, useCallback } from "react"
import { Box, Text, useInput } from "ink"
import type { TuiPendingQuestion } from "../state/types"

interface QuestionPanelProps {
  question: TuiPendingQuestion
  onAnswer: (answer: string) => void
}

export const QuestionPanel: React.FC<QuestionPanelProps> = ({ question, onAnswer }) => {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [customInput, setCustomInput] = useState("")
  const [mode, setMode] = useState<"select" | "input">("select")

  const options = question.options ?? []
  const hasOptions = options.length > 0

  useInput((input, key) => {
    if (mode === "input") {
      if (key.escape) {
        setMode("select")
        setCustomInput("")
        return
      }
      if (key.return) {
        if (customInput.trim()) {
          onAnswer(customInput.trim())
        }
        return
      }
      if (key.backspace || key.delete) {
        setCustomInput(prev => prev.slice(0, -1))
        return
      }
      if (input) {
        setCustomInput(prev => prev + input)
        return
      }
      return
    }

    // select mode
    if (key.escape) {
      // ESC 取消，不回答
      return
    }

    if (hasOptions) {
      if (key.upArrow && selectedIndex > 0) {
        setSelectedIndex(prev => prev - 1)
      } else if (key.downArrow && selectedIndex < options.length - 1) {
        setSelectedIndex(prev => prev + 1)
      } else if (key.return) {
        const selected = options[selectedIndex]
        if (selected) {
          onAnswer(selected.label)
        }
      } else if (input === "e" || input === "E") {
        setMode("input")
      }
    } else {
      // 没有选项，直接进入输入模式
      setMode("input")
    }
  })

  const handleAnswer = useCallback((answer: string) => {
    onAnswer(answer)
  }, [onAnswer])

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">❓ {question.question}</Text>
      </Box>

      {hasOptions && (
        <Box flexDirection="column" marginBottom={1}>
          {options.map((option, index) => (
            <Box key={index}>
              <Text color={index === selectedIndex ? "cyan" : "gray"}>
                {index === selectedIndex ? "▶ " : "  "}
                {option.label}
              </Text>
              {option.description && (
                <Text dimColor> — {option.description}</Text>
              )}
            </Box>
          ))}
        </Box>
      )}

      {mode === "input" && (
        <Box flexDirection="column">
          <Text dimColor>输入自定义回答（ESC 返回选择）：</Text>
          <Box>
            <Text color="yellow">{customInput}</Text>
            <Text color="yellow" dimColor>_</Text>
          </Box>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          {mode === "select"
            ? hasOptions
              ? "↑/↓ 选择 · Enter 确认 · E 输入自定义"
              : "Enter 输入回答"
            : "Enter 提交 · ESC 返回"}
        </Text>
      </Box>
    </Box>
  )
}
