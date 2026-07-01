/** theme — 语义化主题，映射 palette 到 UI 概念。
 *  组件应优先使用 theme.* 而非 palette.* 或裸 hex。 */

import { palette } from "./palette"

export const theme = {
  // ── 文本 ──
  text: palette.white,
  textDim: palette.dim,
  textAccent: palette.cyan,
  textBold: palette.white,

  // ── 状态 ──
  success: palette.green,
  warning: palette.yellow,
  error: palette.red,
  info: palette.blue,
  working: palette.cyan,

  // ── 消息角色 ──
  userMessage: palette.cyan,
  assistantMessage: palette.blue,
  assistantPending: palette.cyan,

  // ── 事件类型 ──
  eventTool: palette.green,
  eventTask: palette.blue,
  eventPlan: palette.cyan,
  eventError: palette.red,

  // ── UI 元素 ──
  border: palette.border,
  borderActive: palette.cyan,
  surface: palette.dim,

  // ── Gate 状态 ──
  gatePass: palette.green,
  gateBlock: palette.red,
  gatePending: palette.yellow,
  gateSkip: palette.dim,
} as const

export type ThemeKey = keyof typeof theme

/** 向后兼容 main.tsx 的 C 对象 — 直接映射 palette。 */
export const C = palette
