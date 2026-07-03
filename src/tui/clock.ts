/** clock — 共享动画时钟（Phase 5）。
 *
 *  ClockContext 消除 tick prop drilling：
 *    - main.tsx 提供 tick + reducedMotion
 *    - 任何需要动画的组件通过 useClock() 消费
 *    - DEEPSEEK_TUI_REDUCED_MOTION=1 关闭所有动画字符
 *
 *  设计决策：
 *    - 用 React context 而非 prop，因为 tick 需要穿透 3+ 层组件
 *    - reducedMotion 在 context 内计算一次，不重复读 env
 */

import { createContext, useContext } from "react"

export interface ClockState {
  /** 单调递增帧计数器。reducedMotion 时固定为 0。 */
  tick: number
  /** DEEPSEEK_TUI_REDUCED_MOTION=1 时为 true */
  reducedMotion: boolean
}

export const ClockContext = createContext<ClockState>({ tick: 0, reducedMotion: false })

/** 消费共享动画时钟。 */
export function useClock(): ClockState {
  return useContext(ClockContext)
}

/** 在模块加载时读一次，避免每个组件重复读 env。 */
export const REDUCED_MOTION = process.env.DEEPSEEK_TUI_REDUCED_MOTION === "1"

/** 对外暴露：根据 reducedMotion 调整原始 tick。
 *  reducedMotion: tick 固定为 0，所有消费者渲染静态帧。 */
export function effectiveTick(rawTick: number): ClockState {
  return {
    tick: REDUCED_MOTION ? 0 : rawTick,
    reducedMotion: REDUCED_MOTION,
  }
}
