/** AppShell — Orcana TUI 主界面布局（Depthline P2：单画布骨架）。
 *
 *  职责：
 *    - 组合 SessionLine / Transcript / ActivityLine / InteractionSlot / Composer / HintBar
 *    - 默认无永久 RightRail / StatusBar / ModeContract（能力迁入 RuntimeInspector overlay）
 *    - Overlay 互斥渲染：confirm / rewind / settings / runtime-inspector
 *    - splash 启动画面保留但不是主功能
 *
 *  永久 chrome ≤ 4 行：SessionLine(1) + ActivityLine(0/1) + Composer(2-8) + HintBar(1)。
 */

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
import { selectRightRail } from "../state/selectors"
import type { TuiState, TuiMode } from "../state/types"
import { Scrollback, type ScrollbackScrollState } from "./Scrollback"
import { SessionLine, type SessionLineData } from "./SessionLine"
import { ActivityLine } from "./ActivityLine"
import { InteractionSlot, ClarificationPanel, type ClarificationWizardState } from "./InteractionSlot"
import { LegacyPlanAdapter } from "./LegacyPlanAdapter"
import { HintBar } from "./HintBar"
import { ComposerFrame } from "./ComposerFrame"
import { fitText } from "./MessageItem"
import { resolveActiveContext } from "../input/types"
import { ConfirmModal } from "./ConfirmModal"
import { RewindModal } from "./RewindModal"
import { RuntimeInspector } from "./overlays/RuntimeInspector"
import { ShortcutsPanel } from "./overlays/ShortcutsPanel"
import { extractRuntimeCounters } from "../format-runtime"
import { selectThinkingDock } from "../thinking"
import { renderMetrics } from "../render-metrics"
import type { OverlayState, SettingsDialogState, ThinkEffort, ModelDialogOption } from "../overlays"
import type { TaskProgressState } from "./PlanPanel"

// Depthline P1: overlay 类型已移至 ../overlays，此处 re-export 保持向后兼容
export type { ThinkEffort, ModelDialogOption, OverlayState } from "../overlays"
export type { SettingsDialogState as RuntimeDialogState } from "../overlays"
export type { SettingsDialogState } from "../overlays"
// Depthline P2: ClarificationWizardState 移至 InteractionSlot，re-export 向后兼容
export type { ClarificationWizardState } from "./InteractionSlot"
export { ClarificationPanel } from "./InteractionSlot"
export type { TaskProgressState } from "./PlanPanel"

// ── 常量 ──

/** 命令列表来自 CommandRegistry（PR-4 单一数据源）。 */
export const SLASH_COMMANDS: SlashCommandHint[] = getCommandHints()

// ── 内部组件 ──

function EmptySurface({ mode, modelName }: { mode: TuiMode; modelName: string }) {
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={theme.brand} bold>Orcana</Text>
        <Text color={theme.textDim}>  mode:</Text>
        <Text color={theme.brand}>{mode}</Text>
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

function RuntimeDialog({ dialog, width }: { dialog: SettingsDialogState; width: number }) {
  const boxWidth = Math.max(42, Math.min(width - 4, 92))
  if (dialog.type === "effort") {
    const options: Array<{ value: ThinkEffort; label: string; desc: string }> = [
      { value: "auto", label: "auto", desc: "自动判断，默认选择" },
      { value: "high", label: "high", desc: "更深推理，适合复杂修改" },
      { value: "max", label: "max", desc: "最大推理预算，适合架构/疑难问题" },
    ]
    return (
      <Box flexDirection="column" borderStyle="single" borderColor={theme.borderActive} paddingX={1} width={boxWidth}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text color={theme.brand} bold>推理深度</Text>
          <Text color={theme.textFaint}>Esc</Text>
        </Box>
        {options.map((item, index) => {
          const selected = index === dialog.selected
          const current = item.value === dialog.current
          return (
            <Box key={item.value} flexDirection="row">
              <Text color={selected ? theme.brand : theme.textFaint}>{selected ? ">" : " "} </Text>
              <Text color={current ? theme.success : selected ? theme.text : theme.textDim}>{item.label.padEnd(5)}</Text>
              <Text color={theme.textFaint}> {item.desc}</Text>
            </Box>
          )
        })}
        {dialog.error && <Text color={theme.error}>{fitText(dialog.error, boxWidth - 4)}</Text>}
      </Box>
    )
  }

  if (dialog.phase === "key") {
    const masked = dialog.keyValue.length > 0 ? "*".repeat(Math.min(dialog.keyValue.length, 32)) : ""
    return (
      <Box flexDirection="column" borderStyle="single" borderColor={theme.borderActive} paddingX={1} width={boxWidth}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text color={theme.brand} bold>配置 API key</Text>
          <Text color={theme.textFaint}>Esc</Text>
        </Box>
        <Text color={theme.textDim}>{dialog.providerName} / {dialog.modelName}</Text>
        <Box flexDirection="row">
          <Text color={theme.info}>key </Text>
          <Text color={dialog.keyValue ? theme.text : theme.textFaint}>{masked || "输入后回车保存"}</Text>
        </Box>
        <Text color={theme.textFaint}>key 会保存到 Orcana 全局 auth，不读取系统环境变量。</Text>
        {dialog.error && <Text color={theme.error}>{fitText(dialog.error, boxWidth - 4)}</Text>}
      </Box>
    )
  }

  if (dialog.phase === "custom") {
    return (
      <Box flexDirection="column" borderStyle="single" borderColor={theme.borderActive} paddingX={1} width={boxWidth}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text color={theme.brand} bold>自定义模型</Text>
          <Text color={theme.textFaint}>Esc</Text>
        </Box>
        <Text color={theme.textDim}>{dialog.providerName}</Text>
        <Box flexDirection="row">
          <Text color={theme.info}>model </Text>
          <Text color={dialog.modelValue ? theme.text : theme.textFaint}>
            {dialog.modelValue || "输入模型 ID，例如 glm-5.2"}
          </Text>
        </Box>
        <Text color={theme.textFaint}>下一步输入 URL，然后输入 key，保存到 Orcana 全局配置。</Text>
        {dialog.error && <Text color={theme.error}>{fitText(dialog.error, boxWidth - 4)}</Text>}
      </Box>
    )
  }

  if (dialog.phase === "url") {
    const fallback = dialog.defaultBaseUrl ? `默认：${dialog.defaultBaseUrl}` : "输入 OpenAI-compatible URL"
    const hint = dialog.defaultBaseUrl
      ? "直接回车使用默认 URL；中转站/Ark/自建服务请输入完整 base URL。"
      : "请输入完整 base URL，例如 https://api.example.com/v1。"
    return (
      <Box flexDirection="column" borderStyle="single" borderColor={theme.borderActive} paddingX={1} width={boxWidth}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text color={theme.brand} bold>模型 API URL</Text>
          <Text color={theme.textFaint}>Esc</Text>
        </Box>
        <Text color={theme.textDim}>{dialog.providerName} / {dialog.modelName}</Text>
        <Box flexDirection="row">
          <Text color={theme.info}>url </Text>
          <Text color={dialog.baseUrlValue ? theme.text : theme.textFaint}>
            {dialog.baseUrlValue || fallback}
          </Text>
        </Box>
        <Text color={theme.textFaint}>{hint}</Text>
        {dialog.error && <Text color={theme.error}>{fitText(dialog.error, boxWidth - 4)}</Text>}
      </Box>
    )
  }

  const maxVisible = 9
  const start = Math.max(0, Math.min(dialog.selected - Math.floor(maxVisible / 2), Math.max(0, dialog.options.length - maxVisible)))
  const visible = dialog.options.slice(start, start + maxVisible)
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.borderActive} paddingX={1} width={boxWidth}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text color={theme.brand} bold>选择模型</Text>
        <Text color={theme.textFaint}>Esc</Text>
      </Box>
      <Box flexDirection="row">
        <Text color={theme.info}>search </Text>
        <Text color={dialog.query ? theme.text : theme.textFaint}>{dialog.query || "输入模型或 provider"}</Text>
      </Box>
      {visible.length === 0 ? (
        <Text color={theme.textFaint}>没有匹配的模型。</Text>
      ) : visible.map((item, index) => {
        const actualIndex = start + index
        const selected = actualIndex === dialog.selected
        const cap = item.custom ? "custom" : `${item.tier}${item.thinking ? " · think" : ""} · ${Math.round(item.contextWindow / 1000)}K`
        return (
          <Box key={`${item.providerId}/${item.modelId}`} flexDirection="row">
            <Text color={selected ? theme.brand : theme.textFaint}>{selected ? ">" : " "} </Text>
            <Text color={item.current ? theme.success : selected ? theme.text : theme.textDim}>
              {fitText(item.modelName, Math.max(12, Math.floor(boxWidth * 0.36)))}
            </Text>
            <Text color={theme.textFaint}>  {fitText(item.providerName, 18)}</Text>
            <Text color={item.configured ? theme.success : theme.warning}>  {item.custom ? "手动" : item.configured ? "ready" : "需要 key"}</Text>
            <Text color={theme.textFaint}>  {cap}</Text>
          </Box>
        )
      })}
      {dialog.options.length > visible.length && (
        <Text color={theme.textFaint}>显示 {start + 1}-{start + visible.length} / {dialog.options.length}，继续输入可过滤。</Text>
      )}
      {dialog.error && <Text color={theme.error}>{fitText(dialog.error, boxWidth - 4)}</Text>}
    </Box>
  )
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

/** Depthline P1: 布局单一事实源。
 *  ChatApp 与 AppShell 都调用本 hook；原 ChatApp 内重复的手算布局已删除。 */
export interface AppLayoutInput {
  rows: number
  cols: number
  state: TuiState
  clarification: ClarificationWizardState | null
  inputChrome: InputChromeState
  /** 是否有 overlay 打开（影响 ThinkingDock waiting_permission 相位）。 */
  overlayActive: boolean
}

export function useAppLayout(input: AppLayoutInput): AppShellLayout {
  const { rows, cols, state, clarification, inputChrome, overlayActive } = input
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
  const thinkingDock = selectThinkingDock(state, { confirmActive: overlayActive })
  return computeAppShellLayout({
    rows,
    cols,
    hasContent,
    isWorking,
    clarification,
    task,
    inputChrome,
    thinkingDockRows: thinkingDock.visible ? 1 : 0,
  })
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
    ? textRows + Math.max(1, inputChrome.commandRows ?? 5)
    : textRows + 1 + (inputChrome.pasteCount > 0 ? 1 : 0)
  // Depthline P2: 单条 Composer 分隔线（+1，原 +2）
  const footerHeight = Math.max(2, Math.min(rows - 8, panelRows + inputRows + 1 + thinkingDockRows + 1))
  const bodyHeight = Math.max(10, rows - footerHeight - 3)
  return { showDash, mode, clarificationRows, taskRows, panelRows, inputRows, footerHeight, bodyHeight }
}

// ── 主组件 ──

export interface InputChromeState {
  commandOpen: boolean
  pasteCount: number
  /** TextArea 当前行数（1-3），用于动态计算 footerHeight */
  textRows: number
  commandRows?: number
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
  /** Depthline P1: 互斥 overlay（confirm / rewind / settings / runtime-inspector）。 */
  overlay: OverlayState
  thinkingEffort: ThinkEffort
  /** PR-1: Answer pending question from agent */
  onAnswerQuestion?: (answer: string) => void
  /** Dismiss the pending question without answering. */
  onCancelQuestion?: () => void
}

export function AppShell(props: AppShellProps) {
  const { state, runtime, prompt, scrollOffset, scrollState, onScrollState, showStartup, clarification, inputChrome, overlay, thinkingEffort } = props
  const { stdout } = useStdout()
  const rows = Math.max(24, stdout?.rows ?? 32)
  const cols = stdout?.columns ?? 96

  // 派生数据
  const rightRail = selectRightRail(state)
  const isWorking = !state.done && !state.errorLine
  const modalActive = overlay.kind !== "none"

  // PR-1: ThinkingDock 视图模型（PR-1.6: 传入 confirmActive 触发 waiting_permission phase）
  const thinkingDock = selectThinkingDock(state, { confirmActive: overlay.kind === "confirm" })

  // Depthline P1: 布局单一事实源
  const layout = useAppLayout({ rows, cols, state, clarification, inputChrome, overlayActive: modalActive })
  const effectiveBodyHeight = computeEffectiveBodyHeight(layout, modalActive)

  // Visual Step 2: 统一计数器
  const counters = extractRuntimeCounters(state)
  const provider = state.session.provider

  // ── splash 启动画面 ──
  if (showStartup) {
    return (
      <Box height={rows} paddingX={1} flexDirection="column">
        <Box flexGrow={1}>
          <InkStartupScreen
            version={runtime.version}
            toolsCount={runtime.tools.length}
            thinkingEffort={props.thinkingEffort}
            modelName={state.modelName}
          />
        </Box>
      </Box>
    )
  }

  const empty = state.messages.length === 0 && state.done && !prompt?.trim()

  // Phase 5: 当前键盘上下文（modal > clarification > CommandShelf > scrollback）
  const activeKeyContext = resolveActiveContext({
    clarificationActive: !!clarification,
    confirmActive: overlay.kind === "confirm",
    rewindListActive: overlay.kind === "rewind" && overlay.state.phase === "list",
    rewindConfirmActive: overlay.kind === "rewind" && overlay.state.phase === "confirm",
    commandOpen: inputChrome.commandOpen,
    runtimeDialogActive: overlay.kind === "settings",
  })

  // SessionLine 数据（Depthline P2）
  const sessionData: SessionLineData = {
    mode: state.mode,
    done: state.done,
    errorLine: state.errorLine,
    status: state.status,
    isWorking,
    queueCount: state.queueCount,
    provider,
    modelName: state.modelName,
    branch: state.session.branch,
    repoRoot: state.session.repoRoot,
    ctxPct: counters.ctxPct,
    cachePct: counters.cachePct,
    cols,
  }

  renderMetrics.incAppShellRender()

  return (
    <Box flexDirection="column" height={rows} paddingX={1}>
      {/* SessionLine — 唯一顶部状态行 */}
      <SessionLine data={sessionData} />

      {/* Depthline P1: Overlay 互斥渲染 */}
      {overlay.kind === "confirm" && (
        <Box marginBottom={1}>
          <ConfirmModal request={overlay.request} position={overlay.position} width={cols - 4} />
        </Box>
      )}
      {overlay.kind === "rewind" && (
        <Box marginBottom={1}>
          <RewindModal modal={overlay.state} width={cols - 4} />
        </Box>
      )}
      {overlay.kind === "settings" && (
        <Box marginBottom={1}>
          <RuntimeDialog dialog={overlay.dialog} width={cols - 4} />
        </Box>
      )}
      {overlay.kind === "runtime-inspector" && (
        <Box marginBottom={1}>
          <RuntimeInspector
            data={rightRail}
            status={state.status}
            done={state.done}
            errorLine={state.errorLine}
            width={cols}
          />
        </Box>
      )}
      {overlay.kind === "shortcuts" && (
        <Box marginBottom={1}>
          <ShortcutsPanel width={cols} />
        </Box>
      )}

      {/* Body: Transcript（单画布，无右栏） */}
      <Box flexDirection="column" height={effectiveBodyHeight} flexGrow={1}>
        {empty ? (
          <EmptySurface mode={state.mode} modelName={state.modelName} />
        ) : (
          <Scrollback
            messages={state.messages}
            width={cols - 2}
            height={Math.max(4, effectiveBodyHeight - 1)}
            status={state.status}
            round={state.round}
            scrollOffset={scrollOffset}
            onScrollState={onScrollState}
            hasActiveTools={state.tools.some(t => t.status === "running")}
          />
        )}
      </Box>

      {/* Footer: LegacyPlanAdapter + ActivityLine + InteractionSlot + Composer + HintBar */}
      <Box flexDirection="column" height={layout.footerHeight}>
        {overlay.kind !== "runtime-inspector" && (
          <LegacyPlanAdapter task={state.task as TaskProgressState | undefined} width={cols} />
        )}
        {overlay.kind !== "runtime-inspector" && (
          <ActivityLine model={thinkingDock} width={cols - 4} />
        )}
        <InteractionSlot
          clarification={clarification}
          pendingQuestion={state.pendingQuestion}
          width={cols}
          onAnswerQuestion={props.onAnswerQuestion}
          onCancelQuestion={props.onCancelQuestion}
        />
        {/* Depthline P2: ComposerFrame — 单条顶部分隔线 */}
        <ComposerFrame width={cols - 2}>
          <OrcanaComposer
            onSubmit={props.submit}
            disabled={showStartup || !!clarification || modalActive || !!state.pendingQuestion}
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
        <HintBar
          busy={isWorking}
          activeContext={activeKeyContext}
          width={cols}
        />
      </Box>
    </Box>
  )
}
