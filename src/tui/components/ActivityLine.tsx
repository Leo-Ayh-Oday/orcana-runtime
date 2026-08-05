/** ActivityLine — 运行态指示行（Depthline P2，替代 ThinkingDock）。
 *
 *  设计规则（Depthline P1 性能契约）：
 *    - 唯一允许持有按需局部 tick 的组件（useLocalTick，idle 不创建 timer）
 *    - 唯一动画 glyph：固定 accent 色的单一声呐 pulse（◌◍◎◉◎◍ / ASCII .oO0Oo）
 *    - 其余 transcript 全部静态
 *    - stalled 用静态标签（P5 落实为 "stalled 8s"）
 */

import React from "react"
import { Box, Text } from "ink"
import { theme } from "../theme/theme"
import { useLocalTick } from "../thinking/useLocalTick"
import { getGlyphTheme } from "../tokens"
import type { ThinkingDockModel } from "../thinking/selectThinkingDock"
import { getLastTokenAt } from "../pending-activity"
import { isStalled } from "../pending-activity"

export interface ActivityLineProps {
  model: ThinkingDockModel
  width: number
}

/** 声呐 pulse 帧（固定 accent 色，约 160ms/帧）。 */
function ActivityPulse({ active }: { active: boolean }) {
  const tick = useLocalTick(active ? 160 : null)
  const g = getGlyphTheme()
  const frame = active
    ? g.sonarFrames[tick % g.sonarFramesLen] ?? "."
    : g.sonarFrames[0] ?? "."
  return <Text color={theme.brand}>{frame}</Text>
}

/** 纯函数：ActivityLine 的显示文本（供测试）。 */
export function activityLineText(model: ThinkingDockModel, stalled: boolean, lastTokenAt: number, now: number): string {
  if (!model.visible) return ""
  const base = stalled ? `stalled ${Math.max(0, Math.round((now - lastTokenAt) / 1000))}s` : model.label
  const tools = (model.activeTools ?? []).map(t => t.count > 1 ? `${t.name} ×${t.count}` : t.name).join(" · ")
  return tools ? `${base}  ·  ${tools}` : base
}

export const ActivityLine = React.memo(function ActivityLine({ model, width }: ActivityLineProps) {
  if (!model.visible) return null

  const active = model.phase !== "idle" && model.phase !== "error" && model.phase !== "waiting_permission"
  const lastTokenAt = getLastTokenAt()
  const now = Date.now()
  const stalled = model.phase !== "error" && model.phase !== "waiting_permission"
    && lastTokenAt > 0 && !(model.activeTools && model.activeTools.length > 0)
    && isStalled(now)

  const text = activityLineText(model, stalled, lastTokenAt, now)
  const color = model.phase === "error" ? theme.error : theme.text

  return (
    <Box flexDirection="row" paddingX={2} height={1}>
      <Box marginRight={1}>
        <ActivityPulse active={active} />
      </Box>
      <Text color={color}>
        {width < 60 ? text.slice(0, Math.max(20, width - 10)) : text}
      </Text>
    </Box>
  )
})
