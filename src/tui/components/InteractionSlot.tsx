/** InteractionSlot — 用户交互区（Depthline P2）。
 *
 *  同时只能存在一个交互面：
 *    - PendingQuestion（agent 提问）
 *    - ClarificationWizard（澄清向导）
 *    - PlanApproval（P4 引入）
 *
 *  非交互的 PlanProgress 不进入本 slot（走 LegacyPlanAdapter）。
 *  ClarificationPanel 从 AppShell 迁移至此。
 */

import React from "react"
import { Box, Text } from "ink"
import { theme } from "../theme/theme"
import { FlowLine } from "./PlanPanel"
import { fitText } from "./MessageItem"
import { QuestionPanel } from "./QuestionPanel"
import type { ClarificationQuestion } from "../../agent/clarification"
import type { TuiPendingQuestion } from "../state/types"

export interface ClarificationWizardState {
  originalPrompt: string
  questions: ClarificationQuestion[]
  index: number
  selected: number
  answers: Array<{ question: string; key: string; label: string }>
  extraPrompt?: string
  rawText: string
}

export interface InteractionSlotProps {
  clarification: ClarificationWizardState | null
  pendingQuestion?: TuiPendingQuestion
  width: number
  onAnswerQuestion?: (answer: string) => void
  onCancelQuestion?: () => void
}

/** Clarification 面板（自 AppShell 迁移）。 */
export function ClarificationPanel({ wizard, width }: { wizard: ClarificationWizardState; width: number }) {
  const question = wizard.questions[wizard.index]
  if (!question) return null
  const flowWidth = Math.max(18, Math.min(width - 4, 72))

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Box flexDirection="row">
        <Text color={theme.brand}>clarify </Text>
        <Text color={theme.textDim}>{wizard.index + 1}/{wizard.questions.length}</Text>
        <Text color={theme.textDim}> / choose one</Text>
      </Box>
      <Text color={theme.text}>{fitText(question.title, Math.max(18, width - 4))}</Text>
      {question.options.map((option, index) => {
        const selected = index === wizard.selected
        return (
          <Box key={`${question.id}-${option.key}`} flexDirection="row">
            <Box width={3}>
              <Text color={selected ? theme.brand : theme.textFaint}>{selected ? ">" : " "}</Text>
            </Box>
            <Box width={4}>
              <Text color={selected ? theme.brand : theme.info}>{option.key}.</Text>
            </Box>
            <Text color={selected ? theme.text : theme.textDim}>
              {fitText(option.label, Math.max(18, width - 12))}
              {option.recommended ? " [recommended]" : ""}
            </Text>
          </Box>
        )
      })}
      <FlowLine width={flowWidth} active />
      <Text color={theme.textFaint}>Up/Down or j/k select  Enter confirm  Esc cancel</Text>
    </Box>
  )
}

/** 纯函数：当前 slot 内容（供测试）。 */
export function activeInteractionKind(clarification: ClarificationWizardState | null, pendingQuestion: TuiPendingQuestion | undefined): "clarification" | "question" | "none" {
  if (clarification) return "clarification"
  if (pendingQuestion) return "question"
  return "none"
}

export const InteractionSlot = React.memo(function InteractionSlot(props: InteractionSlotProps) {
  const { clarification, pendingQuestion, width, onAnswerQuestion, onCancelQuestion } = props
  const kind = activeInteractionKind(clarification, pendingQuestion)
  if (kind === "none") return null

  if (kind === "clarification" && clarification) {
    return <ClarificationPanel wizard={clarification} width={width} />
  }

  if (kind === "question" && pendingQuestion && onAnswerQuestion) {
    return <QuestionPanel question={pendingQuestion} onAnswer={onAnswerQuestion} onCancel={onCancelQuestion} />
  }

  return null
})
