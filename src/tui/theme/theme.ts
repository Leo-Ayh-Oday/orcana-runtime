/** theme — 语义化主题，映射 palette 到 UI 概念（Depthline P5：7-token 收敛）。
 *  组件应优先使用 theme.* 而非 palette.* 或裸 hex。
 *
 *  色彩预算：
 *    text（默认前景） / muted（dim/mist） / faint（fog） / accent / success / warning / danger
 *  边框从 faint 派生，不新增第八色。
 *  领域分类（gate/evidence/patch/task/plan）依靠标签、层级、glyph、展开内容区分，
 *  不再拥有独立主色（评审：颜色只表达激活/成功/警告/错误）。
 *
 *  C 别名保留完整向后兼容。 */

import { palette } from "./palette"

export const theme = {
  // ── 文本层级 ──
  text: palette.white,
  textDim: palette.mist,
  textFaint: palette.fog,
  textAccent: palette.accent,
  textBold: palette.white,

  // ── 品牌 & 模式 ──
  brand: palette.accent,
  brandShimmer: palette.abyssShimmer,
  mode: palette.accent,

  // ── 状态 ──
  success: palette.success,
  successShimmer: palette.jadeShimmer,
  warning: palette.warning,
  warningShimmer: palette.amberShimmer,
  error: palette.danger,
  errorShimmer: palette.coralShimmer,
  danger: palette.danger,
  info: palette.accent,
  working: palette.accent,

  // ── 消息角色 ──
  userMessage: palette.accent,
  assistantMessage: palette.white,
  assistantPending: palette.accent,

  // ── 事件类型（P5：全部收敛，领域靠标签区分） ──
  eventTool: palette.dim,
  eventTask: palette.dim,
  taskShimmer: palette.dim,
  eventPlan: palette.accent,
  eventError: palette.danger,
  eventActivity: palette.accent,
  eventGate: palette.dim,
  eventEvidence: palette.dim,
  eventPatch: palette.dim,

  // ── 实体别名（兼容，收敛到 muted） ──
  gate: palette.dim,
  evidence: palette.dim,
  patch: palette.dim,
  ripple: palette.accent,

  // ── UI 元素 ──
  border: palette.border,
  borderActive: palette.accent,
  surface: palette.fog,

  // ── Gate 状态 ──
  gatePass: palette.success,
  gateBlock: palette.danger,
  gatePending: palette.warning,
  gateSkip: palette.fog,
} as const

export type ThemeKey = keyof typeof theme

/** 向后兼容 — 直接映射 palette。 */
export const C = palette
