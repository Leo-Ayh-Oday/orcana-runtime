/** block-model — Transcript Block 呈现模型（Depthline P4）。
 *
 *  结构化块系统：用户消息 / Agent 正文 / 工具组 / 计划 / 执行摘要 / 系统。
 *  折叠状态不放在派生结果里（评审修正 #4），由 TranscriptViewState 独立管理。
 */

export type BlockKind =
  | "user"
  | "assistant"
  | "tool-group"
  | "plan"
  | "execution-summary"
  | "task"
  | "system"

export type BlockLifecycle = "pending" | "running" | "done" | "error"

export type BlockDisplayMode = "collapsed" | "truncated" | "expanded"

/** 稳定身份字段（评审修正 #3）：id 不用数组下标；
 *  turnId/runId/toolCallId 当前协议未提供时为 undefined（协议演进后补齐）。 */
export interface TranscriptBlockBase {
  /** 稳定 block id（流式增长 / resize 不改变）。 */
  id: string
  kind: BlockKind
  lifecycle: BlockLifecycle
  turnId?: string
  runId?: string
  toolCallId?: string
  /** 是否可选中（tool-group / plan / execution-summary 可选中；正文/用户不可）。 */
  selectable: boolean
  /** 默认显示模式（running→truncated / completed→collapsed / failed→truncated）。 */
  defaultMode: BlockDisplayMode
}

export interface TranscriptBlock extends TranscriptBlockBase {
  /** 摘要行（无 ANSI 文本，渲染层加 marker/颜色）。 */
  summary: string[]
  /** 详情行（展开时渲染）。 */
  details: string[]
}

/** 视图状态（UI-only，独立于派生结果）。 */
export interface TranscriptViewState {
  selectedBlockId: string | null
  displayModes: ReadonlyMap<string, BlockDisplayMode>
}

export const EMPTY_VIEW: TranscriptViewState = { selectedBlockId: null, displayModes: new Map() }

/** 解析某 block 的最终显示模式：视图覆盖 ?? 默认模式。 */
export function displayModeFor(view: TranscriptViewState, block: Pick<TranscriptBlock, "id" | "defaultMode">): BlockDisplayMode {
  return view.displayModes.get(block.id) ?? block.defaultMode
}
