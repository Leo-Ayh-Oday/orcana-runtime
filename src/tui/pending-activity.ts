/** pending-activity — pending 动态状态模型（Phase 5 更新）。
 *
 *  Visual Step 1: 替代 "thinking · starting..." 这种视觉上有动画但信息不变的文案。
 *  基于已有 status 字符串归类为明确的 activity type，不新增 agent 事件语义。
 *
 *  Phase 5 变更:
 *    - 每类 activity 独立 ASCII glyph 序列（routing/reading/streaming 不再共用 spinner）
 *    - reduced-motion 支持：DEEPSEEK_TUI_REDUCED_MOTION=1 时全部返回静态首字符
 *    - stalled 检测：3s 无 token + 无活跃 tool → stalled
 *
 *  规则：
 *    - 不轮换随机动词
 *    - 动画只变 glyph/pulse，stableLabel 不变
 *    - pendingStatus 为空时 classify 返回 "working"
 *    - 条件匹配从具体到模糊：先匹配关键词，再 fallback
 *    - glyph 字符统一从 getGlyphTheme() 获取，避免硬编码 Unicode mojibake
 */

import { getGlyphTheme } from "./tokens"

export type PendingActivity =
  | "routing"
  | "reading"
  | "editing"
  | "verifying"
  | "blocked"
  | "streaming"
  | "stalled"
  | "working"

// ── Phase 5: stalled detection（模块级时间戳） ──

let lastTokenAt = 0
let lastToolAt = 0

/** 流式 token 到达时调用。 */
export function markTokenActivity(): void {
  lastTokenAt = Date.now()
}

/** 工具开始/结束/状态变化时调用。 */
export function markToolActivity(): void {
  lastToolAt = Date.now()
}

/** 重置 stalled 计时器（新 run 开始时调用）。 */
export function resetStalledDetection(): void {
  lastTokenAt = 0
  lastToolAt = 0
}

/** PR-10: 读取最近一次 token 时间戳（供 useStalledAnimation 使用）。 */
export function getLastTokenAt(): number {
  return lastTokenAt
}

/** PR-10: 读取最近一次 tool 时间戳（供 useStalledAnimation 使用）。 */
export function getLastToolAt(): number {
  return lastToolAt
}

/** PR-10: stalled 阈值（3s）暴露为常量，供 hook 复用。 */
export const STALL_THRESHOLD_MS = 3_000

/** 是否进入 stalled 状态：3s 无 token 且无活跃 tool。 */
export function isStalled(now?: number): boolean {
  const ts = now ?? Date.now()
  if (lastTokenAt === 0 && lastToolAt === 0) return false // 尚未开始
  return (ts - lastTokenAt) > STALL_THRESHOLD_MS && (ts - lastToolAt) > STALL_THRESHOLD_MS
}

// ── Activity 分类 ──

/** 将 status 字符串归类为 PendingActivity。 */
export function classifyPendingActivity(status: string): PendingActivity {
  const s = status.toLowerCase()

  // blocked — gate/ripple/permission 阻塞
  if (s.includes("blocked") || s.includes("block") || s.includes("denied")) return "blocked"
  if (s.includes("gate") && (s.includes("fail") || s.includes("block"))) return "blocked"
  if (s.includes("ripple") && s.includes("block")) return "blocked"

  // verifying — typecheck/test/build/evidence
  if (s.includes("verif") || s.includes("check") || s.includes("lint") || s.includes("test")) return "verifying"
  if (s.includes("typecheck") || s.includes("build") || s.includes("compile")) return "verifying"
  if (s.includes("evidence") || s.includes("eval")) return "verifying"

  // editing — patch/write/edit
  if (s.includes("edit") || s.includes("write") || s.includes("patch") || s.includes("modify")) return "editing"

  // reading — tool/file read
  if (s.includes("read") || s.includes("scan") || s.includes("search") || s.includes("list")) return "reading"
  if (s.includes("grep") || s.includes("find") || s.includes("stat")) return "reading"

  // routing — 准备请求、选择模型、构建上下文
  if (s.includes("rout") || s.includes("select") || s.includes("prepare") || s.includes("context")) return "routing"
  if (s.includes("start") || s.includes("init") || s.includes("connect")) return "routing"

  // streaming — 后端正在流式输出文本（status 来自 token_usage 等非工具事件）
  if (s.includes("stream") || s.includes("generating") || s.includes("output")) return "streaming"

  return "working"
}

/** 无状态文本时返回默认 activity。 */
export function defaultActivity(): PendingActivity {
  return "working"
}

/** 每个 activity 的稳定标签（不随 tick 变化）。 */
export function activityLabel(activity: PendingActivity, round: number): string {
  const r = round > 0 ? `  r${round}` : ""
  switch (activity) {
    case "routing": return `preparing context${r}`
    case "reading": return `reading project${r}`
    case "editing": return `applying changes${r}`
    case "verifying": return `verifying${r}`
    case "blocked": return `blocked${r}`
    case "streaming": return `streaming${r}`
    case "stalled": return `stalled${r}`
    case "working": return `working${r}`
  }
}

/** Phase 5: pending activity glyph。
 *  每类 activity 使用独立 glyph 序列（不再共用 spinner）。
 *  reducedMotion 由调用方通过 tick=0 处理（零 tick → 首字符 = 静态）。 */
export function activityGlyph(activity: PendingActivity, tick: number): string {
  const g = getGlyphTheme()

  switch (activity) {
    case "routing": return g.routingGlyphs[tick % g.routingGlyphsLen] ?? "~"
    case "reading": return g.readingGlyphs[tick % g.readingGlyphsLen] ?? "."
    case "editing": return g.editingGlow[tick % g.editingGlowLen] ?? ">"
    case "verifying": return g.verifyWave[tick % g.verifyWaveLen] ?? "."
    case "blocked": return tick % 2 === 0 ? g.warningIcon : " "
    case "streaming": return g.streamingGlyphs[tick % g.streamingGlyphsLen] ?? "-"
    case "stalled": return g.stalledGlyph
    case "working": return g.spinnerChars[tick % g.spinnerLen] ?? "?"
  }
}

/** 格式化 pending 行：glyph + label。 */
export function formatPendingLine(
  activity: PendingActivity,
  tick: number,
  round: number,
): string {
  const glyph = activityGlyph(activity, tick)
  const label = activityLabel(activity, round)
  return `${glyph} ${label}`
}
