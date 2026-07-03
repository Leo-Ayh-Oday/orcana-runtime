/** theme — 语义化主题，映射 palette 到 UI 概念。
 *  组件应优先使用 theme.* 而非 palette.* 或裸 hex。
 *
 *  Phase 1: 28 个语义键。gate/evidence/patch 各用独立色，不再撞车。
 *  C 别名保留完整向后兼容。 */

import { palette } from "./palette"

export const theme = {
  // ── 文本层级 ──
  text: palette.white,
  textDim: palette.mist,
  textFaint: palette.fog,
  textAccent: palette.abyss,
  textBold: palette.white,

  // ── 品牌 & 模式 ──
  brand: palette.abyss,
  brandShimmer: palette.abyssShimmer, // PR-1: 涟漪 propagate 扫光
  mode: palette.abyss,

  // ── 状态 ──
  success: palette.jade,
  successShimmer: palette.jadeShimmer, // PR-1: settled 相位扫光
  warning: palette.amber,
  warningShimmer: palette.amberShimmer, // PR-1: verify 相位扫光
  error: palette.coral,
  errorShimmer: palette.coralShimmer, // PR-1: stalled 渐变终点
  danger: palette.coral,        // alias — 语义上等同于 error
  info: palette.sonar,
  working: palette.abyss,

  // ── 消息角色 ──
  userMessage: palette.cyan,
  assistantMessage: palette.blue,
  assistantPending: palette.abyss,

  // ── 事件类型 ──
  eventTool: palette.jade,       // 工具调用 — 翡翠绿
  eventTask: palette.teal,       // 任务 — 暗流青（曾用 blue）
  taskShimmer: palette.tealShimmer, // PR-1: task 扫光
  eventPlan: palette.abyss,      // 计划 — 品牌蓝（曾用 cyan）
  eventError: palette.coral,     // 错误 — 珊瑚红（曾用 red）
  eventActivity: palette.sonar,  // 活动 — 声呐蓝（曾用 yellow）
  eventGate: palette.gate,       // 门禁 — 粉红（曾用 yellow）
  eventEvidence: palette.evidence, // 证据 — 紫罗兰（曾用 blue）
  eventPatch: palette.patch,     // 补丁 — 薄荷（曾用 green）

  // ── 实体别名（RightRail 等用） ──
  gate: palette.gate,
  evidence: palette.evidence,
  patch: palette.patch,
  ripple: palette.abyss,

  // ── UI 元素 ──
  border: palette.border,
  borderActive: palette.abyss,
  surface: palette.fog,

  // ── Gate 状态 ──
  gatePass: palette.jade,
  gateBlock: palette.coral,
  gatePending: palette.amber,
  gateSkip: palette.fog,
} as const

export type ThemeKey = keyof typeof theme

/** 向后兼容 — 直接映射 palette，旧代码 C.cyan / C.green 等全部可用。
 *  新增 C.evidence / C.gate / C.patch 等也可通过 C 访问，但推荐用 theme.*。 */
export const C = palette
