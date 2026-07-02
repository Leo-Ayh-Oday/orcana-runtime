/** AppShell — Orcana TUI 主界面布局。
 *
 *  职责：
 *    - 组合 HeaderBar / StatusBar / Scrollback / RightRail / PlanPanel / OrcanaComposer / FooterHints
 *    - 宽屏 (>= tuiTokens.layout.breakpointCompact cols)：Scrollback + RightRail 并排
 *    - 窄屏 (< tuiTokens.layout.breakpointCompact cols)：隐藏 RightRail
 *    - splash 启动画面保留但不是主功能
 *    - 消费 PR-1 TuiState（通过 selectors + 直接字段）
 *
 *  从 main.tsx 的 ChatApp 渲染部分提取，ChatApp 保留为状态管理层。 */

import React from "react"
import { Box, Text, useStdout } from "ink"
import { C } from "../theme/theme"
import { tuiTokens } from "../tokens"
import type { Runtime } from "../../runtime/bootstrap"
import { InkStartupScreen } from "../../ui/ink-startup"
import type { SlashCommandHint } from "../input"
import { OrcanaComposer } from "./OrcanaComposer"
import { getCommandHints } from "../commands/registry"
import type { ClarificationQuestion } from "../../agent/clarification"
import { selectRightRail, selectEvidenceSummary, selectGateSummary } from "../state/selectors"
import type { TuiState } from "../state/types"
import { HeaderBar } from "./HeaderBar"
import { StatusBar } from "./StatusBar"
import { Scrollback, type ScrollbackScrollState } from "./Scrollback"
import { RightRail } from "./RightRail"
import { PlanPanel, FlowLine, type TaskProgressState } from "./PlanPanel"
import { FooterHints } from "./FooterHints"
import { fitText } from "./MessageItem"

// ── 常量 ──

/** 命令列表来自 CommandRegistry（PR-4 单一数据源）。
 *  保留 SlashCommandHint 类型的 re-export 供旧代码兼容。 */
export const SLASH_COMMANDS: SlashCommandHint[] = getCommandHints()

// ── ClarificationWizardState（从 main.tsx 提取） ──

export interface ClarificationWizardState {
  originalPrompt: string
  questions: ClarificationQuestion[]
  index: number
  selected: number
  answers: Array<{ question: string; key: string; label: string }>
  extraPrompt?: string
  rawText: string
}

// ── 内部组件 ──

function EmptySurface() {
  return (
    <Box flexDirection="column">
      <Text color={C.cyan} bold>Orcana</Text>
      <Text color={C.dim}>Harness runtime ready. Type / for commands.</Text>
      <Box height={1} />
      <Text color={C.blue}>status <Text color={C.dim}>/</Text> ready</Text>
      <Text color={C.dim}>model {process.env.DEEPSEEK_MODEL_OVERRIDE ?? "deepseek-v4-pro"}</Text>
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

// ── AppShell ──

export interface InputChromeState {
  commandOpen: boolean
  pasteCount: number
  /** TextArea 当前行数（1-3），用于动态计算 footerHeight */
  textRows: number
}

export interface AppShellProps {
  state: TuiState
  runtime: Runtime
  prompt?: string
  tick: number
  scrollOffset: number
  scrollState: ScrollbackScrollState
  onScrollState: (state: ScrollbackScrollState) => void
  showStartup: boolean
  clarification: ClarificationWizardState | null
  inputChrome: InputChromeState
  submit: (value: string) => void
  answerClarification: (answer: { question: string; key: string; label: string }) => void
  moveClarificationSelection: (delta: number) => void
  cancelClarification: () => void
  scrollUp: (amount?: number) => void
  scrollDown: (amount?: number) => void
  setInputChrome: (chrome: InputChromeState) => void
}

// ── 布局计算（纯函数，便于测试） ──

export interface AppShellLayoutInput {
  rows: number
  cols: number
  hasDash: boolean
  isWorking: boolean
  clarification: ClarificationWizardState | null
  task: TaskProgressState | undefined
  inputChrome: InputChromeState
}

export interface AppShellLayout {
  hasDash: boolean
  showDash: boolean
  clarificationRows: number
  taskRows: number
  panelRows: number
  inputRows: number
  footerHeight: number
  bodyHeight: number
}

export function computeAppShellLayout(input: AppShellLayoutInput): AppShellLayout {
  const { rows, cols, hasDash, isWorking, clarification, task, inputChrome } = input
  const question = clarification?.questions[clarification.index]
  const clarificationRows = clarification ? Math.min(10, 4 + (question?.options.length ?? 0)) : 0
  const taskRows = task ? (task.phase === "planning" ? 3 : Math.min(5, 1 + Math.min(3, task.steps.length))) : 0
  const panelRows = clarificationRows || taskRows
  const showDash = hasDash && cols >= tuiTokens.layout.breakpointCompact
  // OrcanaComposer 多行布局：TextArea(textRows 行) + 状态行(1行) + 可能的粘贴指示(1行)
  // 命令面板打开时占 5 行（3 条候选 + 标题 + 空行）
  // FooterHints 占 1 行，footerHeight 需额外 +1
  const textRows = inputChrome.textRows > 0 ? inputChrome.textRows : 1
  const inputRows = inputChrome.commandOpen
    ? 5
    : textRows + 1 + (inputChrome.pasteCount > 0 ? 1 : 0)
  const footerHeight = Math.max(2, Math.min(rows - 8, panelRows + inputRows + 1))
  const bodyHeight = Math.max(10, rows - footerHeight - 3)
  return { hasDash, showDash, clarificationRows, taskRows, panelRows, inputRows, footerHeight, bodyHeight }
}

export function AppShell(props: AppShellProps) {
  const { state, runtime, prompt, tick, scrollOffset, scrollState, onScrollState, showStartup, clarification, inputChrome } = props
  const { stdout } = useStdout()
  const rows = Math.max(24, stdout?.rows ?? 32)
  const cols = stdout?.columns ?? 96

  // 派生数据
  const task = state.task as TaskProgressState | undefined
  const rightRail = selectRightRail(state)
  const evidence = selectEvidenceSummary(state)
  const gates = selectGateSummary(state)
  const isWorking = !state.done && !state.errorLine
  const hasDash = rightRail.round > 0 || rightRail.toolHistory.length > 0

  // 布局计算
  const layout = computeAppShellLayout({ rows, cols, hasDash, isWorking, clarification, task, inputChrome })

  // footerTelemetry
  const footerTelemetry = fitText(
    (state.telemetry || `ctx 0% / cache 0% / r0`)
      .replace(`model ${state.modelName} / `, "")
      .replace(`${state.modelName} / `, "")
      .replace(/^model\s+/i, "")
      .replace(/\s*\/\s*/g, "  ")
      .replace(/\bround\b/gi, "r"),
    Math.max(16, Math.min(34, Math.floor(cols * 0.3))),
  )

  // ── splash 启动画面 ──
  if (showStartup) {
    return (
      <Box height={rows} paddingX={1} flexDirection="column">
        <Box flexGrow={1}>
          <InkStartupScreen
            version={runtime.version}
            toolsCount={runtime.tools.length}
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
      {/* HeaderBar */}
      <HeaderBar
        modelName={state.modelName}
        status={state.status}
        done={state.done}
        errorLine={state.errorLine}
        queueCount={state.queueCount}
        tick={tick}
        cols={cols}
        isWorking={isWorking}
      />

      {/* StatusBar */}
      <StatusBar
        messagesCount={state.messages.length}
        scrollOffset={scrollState.normalizedOffset}
        scrollMax={scrollState.maxOffset}
        taskDone={task?.done ?? 0}
        taskTotal={task?.total ?? 0}
        taskPhase={task?.phase ?? ""}
        gatePass={gates.pass}
        gateBlock={gates.block}
        gateSkip={gates.skip}
        evidencePassed={evidence.passed}
        evidenceFailed={evidence.failed}
        evidenceRunning={0}
      />

      {/* Body: Scrollback + RightRail */}
      <Box flexDirection="row" height={layout.bodyHeight} flexGrow={1}>
        <Box flexDirection="column" flexGrow={1} marginRight={1}>
          <Box flexDirection="column" flexGrow={1}>
            {empty ? (
              <EmptySurface />
            ) : (
              <Scrollback
                messages={state.messages}
                width={cols - (layout.showDash ? tuiTokens.layout.rail.max : 2)}
                height={Math.max(4, layout.bodyHeight - 1)}
                tick={tick}
                status={state.status}
                scrollOffset={scrollOffset}
                onScrollState={onScrollState}
              />
            )}
          </Box>
          {state.errorLine && <Text color={C.red}>{state.errorLine}</Text>}
        </Box>

        {layout.showDash && (
          <Box width={Math.min(tuiTokens.layout.rail.max, Math.max(tuiTokens.layout.rail.min, Math.floor(cols * 0.28)))}>
            <RightRail {...rightRail} tick={tick} />
          </Box>
        )}
      </Box>

      {/* Footer: PlanPanel/ClarificationPanel + InputLine + FooterHints */}
      <Box flexDirection="column" height={layout.footerHeight}>
        {clarification ? (
          <ClarificationPanel wizard={clarification} width={cols} tick={tick} />
        ) : (
          <PlanPanel task={task} width={cols} tick={tick} />
        )}
        <OrcanaComposer
          onSubmit={props.submit}
          disabled={showStartup || !!clarification}
          placeholder={clarification ? "按上方选项确认..." : isWorking ? "输入后续消息，Enter 排队..." : "Message Orcana..."}
          status={isWorking ? `agent running · Enter queues next message${state.queueCount > 0 ? ` · queued ${state.queueCount}` : ""}` : state.status}
          rightStatus={footerTelemetry}
          commands={SLASH_COMMANDS}
          focused={!showStartup}
          onChromeChange={props.setInputChrome}
        />
        <FooterHints busy={isWorking} clarifying={!!clarification} width={cols} />
      </Box>
    </Box>
  )
}
