/** motion — 静态动效配置（P1 替代 clock.ts）。
 *
 *  设计原则（Depthline P1）：
 *    - 不再有全局 ClockContext / 共享 tick：任何 tick 变化只影响持有它的组件子树
 *    - reduced-motion 是无 React 状态的静态配置，模块加载时读一次
 *    - 唯一允许持有按需局部 tick 的组件是 ActivityLine（P2 起），
 *      P1 期间 SonarPulse 沿用 useLocalTick
 */

/** ORCANA_TUI_REDUCED_MOTION=1 关闭所有动画 glyph。 */
export const reducedMotion = process.env.ORCANA_TUI_REDUCED_MOTION === "1"
