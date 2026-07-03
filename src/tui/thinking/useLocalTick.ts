/** useLocalTick — 组件级独立动画时钟（PR-1）。
 *
 *  与 ClockContext 完全解耦：
 *    - ClockContext 服务于全局同步动画（Scrollback pending glyph、HeaderBar pulse）
 *    - useLocalTick 服务于独立节奏组件（SonarPulse 140ms、其他未来微动效）
 *
 *  intervalMs=null 时停止 tick 并重置为 0。
 */

import { useState, useEffect } from "react"

/** 组件级独立 tick。intervalMs 为 null 时暂停并归零。 */
export function useLocalTick(intervalMs: number | null): number {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (intervalMs === null) {
      setTick(0)
      return
    }
    const id = setInterval(() => setTick(t => t + 1), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])

  return tick
}
