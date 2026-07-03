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
import { theme } from "../theme/theme"
import { tuiTokens } from "../tokens"
import type { Runtime } from "../../runtime/bootstrap"
import { InkStartupScreen } from "../../ui/ink-startup"
import type { SlashCommandHint } from "../input"
import { OrcanaComposer } from "./OrcanaComposer"
import { getCommandHints } from "../commands/registry"
import type { ClarificationQuestion } from "../../agent/clarification"
import { selectRightRail, selectRuntimePanel } from "../state/selectors"
import type { TuiState, TuiMode } from "../state/types"
import { HeaderBar } from "./HeaderBar"
import { StatusBar } from "./StatusBar"
import { Scrollback, type ScrollbackScrollState } from "./Scrollback"
import { RightRail } from "./RightRail"
import { PlanPanel, FlowLine, type TaskProgressState } from "./PlanPanel"
import { FooterHints } from "./FooterHints"
import { ComposerFrame } from "./ComposerFrame"
import { fitText } from "./MessageItem"
import { resolveActiveContext } from "../input/types"
import { ModeContract, ModeBadge } from "./ModeContract"
import { ConfirmModal } from "./ConfirmModal"
import { RewindModal, type RewindModalState } from "./RewindModal"
import type { ConfirmRequest } from "../confirm-stubs"
import { extractRuntimeCounters, formatRuntimeCounters } from "../format-runtime"
import { useClock } from "../clock"
import { ThinkingDock, selectThinkingDock } from "../thinking"

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

function EmptySurface({ mode, modelName }: { mode: TuiMode; modelName: string }) {
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={theme.brand} bold>Orcana</Text>
        <Text color={theme.textDim}>  mode:</Text>
        <ModeBadge mode={mode} />
        <Text color={theme.textDim}>  {modelName}</Text>
      </Box>
      <Box height={1} />
      <Text color={theme.textDim}>Try:</Text>
      <Box flexDirection="row">
        <Text color={theme.brand}>  /status</Text>
        <Text color={theme.textDim}>  ·  /gates  ·  /evidence  ·  /models</Text>
      </Box>
      <Text color={theme.textDim}>  /help  — all commands</Text>
      <Box height={1} />
      <Text color={theme.textDim}>Type your request or / for commands.</Text>
    </Box>
  )
}

function ClarificationPanel({ wizard, width }: { wizard: ClarificationWizardState; width: number }) {
  const { tick } = useClock()
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
  /** Phase 5: Confirm modal state */
  confirmModal: { request: ConfirmRequest; position: string } | null
  /** Phase 5: Rewind modal state */
  rewindModal: RewindModalState | null
}

// ── 布局计算（纯函数，便于测试） ──

export interface AppShellLayoutInput {
  rows: number
  cols: number
  /** 是否有 runtime 信号（需要显示 dash/rail 内容） */
  hasContent: boolean
  isWorking: boolean
  clarification: ClarificationWizardState | null
  task: TaskProgressState | undefined
  inputChrome: InputChromeState
  /** PR-1: ThinkingDock 可见时为 1，否则 0 */
  thinkingDockRows?: number
}

/** Phase 2: 布局模式 */
export type LayoutMode = "tiny" | "narrow" | "standard" | "comfortable"

export interface AppShellLayout {
  showDash: boolean
  mode: LayoutMode
  clarificationRows: number
  taskRows: number
  panelRows: number
  inputRows: number
  footerHeight: number
  bodyHeight: number
}

export function computeEffectiveBodyHeight(layout: Pick<AppShellLayout, "bodyHeight">, modalActive: boolean): number {
  return modalActive ? Math.max(10, layout.bodyHeight - 6) : layout.bodyHeight
}

export function computeAppShellLayout(input: AppShellLayoutInput): AppShellLayout {
  const { rows, cols, hasContent, isWorking, clarification, task, inputChrome, thinkingDockRows = 0 } = input
  const question = clarification?.questions[clarification.index]
  const clarificationRows = clarification ? Math.min(10, 4 + (question?.options.length ?? 0)) : 0
  const taskRows = task ? (task.phase === "planning" ? 3 : Math.min(5, 1 + Math.min(3, task.steps.length))) : 0
  const panelRows = clarificationRows || taskRows

  // Phase 2: 四档布局模式
  let mode: LayoutMode
  if (cols < 60) mode = "tiny"
  else if (cols < 96) mode = "narrow"
  else if (cols < 120) mode = "standard"
  else mode = "comfortable"

  // RightRail 仅在 standard/comfortable 且有 runtime 内容时显示
  const showDash = hasContent && (mode === "standard" || mode === "comfortable")
  const textRows = inputChrome.textRows > 0 ? inputChrome.textRows : 1
  const inputRows = inputChrome.commandOpen
    ? 5
    : textRows + 1 + (inputChrome.pasteCount > 0 ? 1 : 0)
  // PR-1: ThinkingDock 在 footer 中占 1 行
  // PR-2: ComposerFrame 上下分隔线各占 1 行（+2）
  const footerHeight = Math.max(2, Math.min(rows - 8, panelRows + inputRows + 1 + thinkingDockRows + 2))
  const bodyHeight = Math.max(10, rows - footerHeight - 3)
  return { showDash, mode, clarificationRows, taskRows, panelRows, inputRows, footerHeight, bodyHeight }
}

export function AppShell(props: AppShellProps) {
  const { state, runtime, prompt, scrollOffset, scrollState, onScrollState, showStartup, clarification, inputChrome, confirmModal, rewindModal } = props
  const { stdout } = useStdout()
  const rows = Math.max(24, stdout?.rows ?? 32)
  const cols = stdout?.columns ?? 96

  // 派生数据
  const task = state.task as TaskProgressState | undefined
  const rightRail = selectRightRail(state)
  const isWorking = !state.done && !state.errorLine
  const hasRuntimeSignal =
    rightRail.round > 0
    || rightRail.toolHistory.length > 0
    || rightRail.rippleFindings.length > 0
    || rightRail.runtime.gateSummary.total > 0
    || rightRail.runtime.evidenceSummary.total > 0
    || rightRail.runtime.patchSummary.total > 0
    || rightRail.runtime.activeTools > 0
  const hasContent = cols >= tuiTokens.layout.breakpointComfortable || hasRuntimeSignal
  const modalActive = confirmModal !== null || rewindModal !== null

  // PR-1: ThinkingDock 视图模型（PR-1.6: 传入 confirmActive 触发 waiting_permission phase）
  const thinkingDock = selectThinkingDock(state, { confirmActive: confirmModal !== null })

  // Phase 2: 布局计算 — 四档模式 (tiny/narrow/standard/comfortable)
  const layout = computeAppShellLayout({ rows, cols, hasContent, isWorking, clarification, task, inputChrome, thinkingDockRows: thinkingDock.visible ? 1 : 0 })
  const effectiveBodyHeight = computeEffectiveBodyHeight(layout, modalActive)

  // Visual Step 2: 统一计数器
  const counters = extractRuntimeCounters(state)
  const provider = state.session.provider
  const runtimePanel = selectRuntimePanel(state)

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

  // Phase 5: 当前键盘上下文（modal > clarification > scrollback）
  const activeKeyContext = resolveActiveContext({
    clarificationActive: !!clarification,
    confirmActive: confirmModal !== null,
    rewindListActive: rewindModal?.phase === "list",
    rewindConfirmActive: rewindModal?.phase === "confirm",
  })

  return (
    <Box flexDirection="column" height={rows} paddingX={1}>
      {/* HeaderBar (Phase 4a: single-line status bar) */}
      <HeaderBar
        modelName={state.modelName}
        provider={provider}
        mode={state.mode}
        done={state.done}
        errorLine={state.errorLine}
        status={state.status}
        queueCount={state.queueCount}
        cols={cols}
        isWorking={isWorking}
        round={counters.round}
        ctxPct={counters.ctxPct}
        cachePct={counters.cachePct}
      />

      {/* StatusBar (Phase 2: narrow mode absorbs RightRail runtime info) */}
      <StatusBar
        counters={counters}
        cols={cols}
        ripplePhase={rightRail.runtime.ripplePhase}
        narrow={layout.mode === "tiny" || layout.mode === "narrow"}
      />

      {/* Phase 5: Modal overlays (between StatusBar and Body) */}
      {confirmModal && (
        <Box marginBottom={1}>
          <ConfirmModal request={confirmModal.request} position={confirmModal.position} width={cols - 4} />
        </Box>
      )}
      {rewindModal && (
        <Box marginBottom={1}>
          <RewindModal modal={rewindModal} width={cols - 4} />
        </Box>
      )}

      {/* Body: Scrollback + RightRail */}
      <Box flexDirection="row" height={effectiveBodyHeight} flexGrow={1}>
        <Box flexDirection="column" flexGrow={1} marginRight={1}>
          <Box flexDirection="column" flexGrow={1}>
            {empty ? (
              <EmptySurface mode={state.mode} modelName={state.modelName} />
            ) : (
              <Scrollback
                messages={state.messages}
                width={cols - (layout.showDash ? tuiTokens.layout.rail.max : 2)}
                height={Math.max(4, effectiveBodyHeight - 1)}
                status={state.status}
                round={state.round}
                scrollOffset={scrollOffset}
                onScrollState={onScrollState}
                hasActiveTools={state.tools.some(t => t.status === "running")}
              />
            )}
          </Box>
          {state.errorLine && <Text color={theme.error}>{state.errorLine}</Text>}
        </Box>

        {layout.showDash && (
          <Box flexDirection="row">
            <Text color={theme.border}>│</Text>
            <Box width={layout.mode === "comfortable" ? tuiTokens.layout.rail.ideal : tuiTokens.layout.rail.min} flexDirection="column" paddingLeft={1}>
              <ModeContract mode={state.mode} width={Math.max(24, tuiTokens.layout.rail.min - 4)} />
              <Box height={1} />
              <RightRail {...rightRail} />
            </Box>
          </Box>
        )}
      </Box>

      {/* Footer: PlanPanel/ClarificationPanel + ThinkingDock + ComposerFrame + FooterHints */}
      <Box flexDirection="column" height={layout.footerHeight}>
        {clarification ? (
          <ClarificationPanel wizard={clarification} width={cols} />
        ) : (
          <PlanPanel task={task} width={cols} />
        )}
        {/* PR-1: ThinkingDock — 固定运行态显示，不进入 messages */}
        <ThinkingDock model={thinkingDock} width={cols - 4} />
        {/* PR-2: ComposerFrame — 固定输入框 frame，上下分隔线 */}
        <ComposerFrame width={cols - 2}>
          <OrcanaComposer
            onSubmit={props.submit}
            disabled={showStartup || !!clarification || modalActive}
            placeholder={
              modalActive ? "modal active" :
              clarification ? "Choose an option above..." :
              isWorking ? "Queue next message..." :
              "Message Orcana..."
            }
            status={
              isWorking
                ? `agent running · Enter queues${state.queueCount > 0 ? ` (queued ${state.queueCount})` : ""}`
                : ""
            }
            commands={SLASH_COMMANDS}
            focused={!showStartup && !modalActive}
            onChromeChange={props.setInputChrome}
          />
        </ComposerFrame>
        <FooterHints
          busy={isWorking}
          activeContext={activeKeyContext}
          width={cols}
          commandOpen={inputChrome.commandOpen}
        />
      </Box>
    </Box>
  )
}
