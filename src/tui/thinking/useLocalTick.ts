/** useLocalTick — 组件级独立动画时钟（PR-1）。
 *
 *  Depthline P1：全局 ClockContext 已删除。这是唯一的局部 tick 原语：
 *    - intervalMs=null 时停止 tick 并重置为 0（idle 不创建 timer）
 *    - ORCANA_TUI_PROFILE=1 时向 render-metrics 登记存活定时器
 *
 *  使用规范：仅 ActivityLine（及过渡期 SonarPulse）允许持有 tick。
 */

import { useState, useEffect } from "react"
import { renderMetrics } from "../render-metrics"

/** 组件级独立 tick。intervalMs 为 null 时暂停并归零。 */
export function useLocalTick(intervalMs: number | null): number {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (intervalMs === null) {
      setTick(0)
      return
    }
    const id = setInterval(() => setTick(t => t + 1), intervalMs)
    renderMetrics.trackTimer(id)
    return () => {
      clearInterval(id)
      renderMetrics.untrackTimer(id)
    }
  }, [intervalMs])

  return tick
}
