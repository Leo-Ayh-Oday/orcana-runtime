/** pending-activity — pending 动态状态模型。
 *
 *  Visual Step 1: 替代 "thinking · starting..." 这种视觉上有动画但信息不变的文案。
 *  基于已有 status 字符串归类为明确的 activity type，不新增 agent 事件语义。
 *
 *  规则：
 *    - 不轮换随机动词
 *    - 动画只变 glyph/pulse，stableLabel 不变
 *    - pendingStatus 为空时 classify 返回 "working"
 *    - 条件匹配从具体到模糊：先匹配关键词，再 fallback
 */

export type PendingActivity =
  | "routing"
  | "reading"
  | "editing"
  | "verifying"
  | "blocked"
  | "streaming"
  | "working"

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
    case "working": return `working${r}`
  }
}

/** pending activity glyph。tick 驱动变化，但 glyph 本身不改变 stableLabel。 */
export function activityGlyph(activity: PendingActivity, tick: number): string {
  const spinners = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
  switch (activity) {
    case "routing": return spinners[tick % 10] ?? "?"
    case "reading": return spinners[tick % 10] ?? "?"
    case "editing": return "›‹›‹›‹›‹›‹"[tick % 10] ?? "›"
    case "verifying": return "▁▂▃▄▅▆▇█▇▆▅▄▃▂"[tick % 14] ?? "▁"
    case "blocked": return tick % 2 === 0 ? "!" : " "
    case "streaming": return spinners[tick % 10] ?? "?"
    case "working": return spinners[tick % 10] ?? "?"
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
