/** useBlink — 自包含动画时钟，不污染父组件 state。
 *
 *  Phase 4 设计要点：
 *    - 每个 pending MessageItem 独立维护自己的 tick，不共享全局 tick
 *    - Scrollback 不再感知 pending 动画 —— useMemo 依赖从此不含 tick
 *    - enabled=false 时不清除 interval（由 useEffect cleanup 处理）
 *    - intervalMs 默认 600ms（~1.7fps），匹配终端 spinner 视觉节奏
 */

import { useEffect, useState } from "react"

/** 自包含动画 tick。enabled 为 true 时按 intervalMs 递增。
 *  返回的 tick 值从 0 开始，每 intervalMs 递增 1。 */
export function useBlink(enabled: boolean, intervalMs = 600): number {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!enabled) return
    const id = setInterval(() => setTick(t => t + 1), intervalMs)
    return () => clearInterval(id)
  }, [enabled, intervalMs])

  // Reset tick when enabled changes from false → true
  useEffect(() => {
    if (enabled) setTick(0)
  }, [enabled])

  return tick
}
