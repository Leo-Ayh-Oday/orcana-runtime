/** useStalledAnimation — PR-10: stalled 渐变红机制。
 *
 *  规则（spec B.3）：
 *    - 3 秒无新 token 且无活跃 tool 触发 stalled（STALLED_FADE_DURATION_MS 之前）
 *    - 2 秒线性淡入到 error 色（intensity 0 → 1）
 *    - 新 token 到达立即重置（intensity 回到 0，无淡出）
 *    - reduced-motion 时立即 intensity = 1（无渐变）
 *
 *  使用方式：
 *    const { isStalled, intensity } = useStalledAnimation(lastTokenAt, hasActiveTools)
 *    const color = interpolateColor(normalColor, theme.error, intensity)
 */

import { useClock, REDUCED_MOTION } from "../clock"

/** stalled 状态下，颜色从 normal 渐变到 error 的时间窗口（2s）。 */
export const STALLED_FADE_DURATION_MS = 2_000

/** stalled 触发阈值（与 pending-activity.ts STALL_THRESHOLD_MS 同步）。 */
export const STALLED_THRESHOLD_MS = 3_000

/** hex 颜色线性插值。
 *  - intensity=0 返回 normalColor（归一化为 #rrggbb 小写）
 *  - intensity=1 返回 errorColor（归一化为 #rrggbb 小写）
 *  - 输入格式：#RRGGBB 或 RRGGBB（不区分大小写）
 *  - 输出格式：#rrggbb（小写，带 # 前缀）
 *  - 解析失败时返回 normalColor 原值（不归一化） */
export function interpolateColor(normalColor: string, errorColor: string, intensity: number): string {
  // clamp intensity to [0, 1]
  const t = Math.max(0, Math.min(1, intensity))

  const n = parseHex(normalColor)
  const e = parseHex(errorColor)
  if (!n || !e) return normalColor // 解析失败 → 回退到 normal

  if (t === 0) return `#${toHex(n[0])}${toHex(n[1])}${toHex(n[2])}`
  if (t === 1) return `#${toHex(e[0])}${toHex(e[1])}${toHex(e[2])}`

  const r = Math.round(n[0] + (e[0] - n[0]) * t)
  const g = Math.round(n[1] + (e[1] - n[1]) * t)
  const b = Math.round(n[2] + (e[2] - n[2]) * t)
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim())
  if (!m) return null
  const v = m[1]!
  return [
    parseInt(v.slice(0, 2), 16),
    parseInt(v.slice(2, 4), 16),
    parseInt(v.slice(4, 6), 16),
  ]
}

function toHex(n: number): string {
  return n.toString(16).padStart(2, "0")
}

export interface StalledAnimationState {
  isStalled: boolean
  /** 0..1 线性渐变强度。 */
  intensity: number
}

/** 纯函数：根据时间戳计算 stalled 状态与 intensity。
 *  抽离为纯函数便于单元测试。 */
export function computeStalledIntensity(
  lastTokenAt: number,
  hasActiveTools: boolean,
  now: number,
  reducedMotion: boolean,
): StalledAnimationState {
  // 未开始（lastTokenAt === 0）或工具运行中 → 不 stalled
  if (lastTokenAt === 0 || hasActiveTools) {
    return { isStalled: false, intensity: 0 }
  }

  const elapsedSinceToken = now - lastTokenAt
  if (elapsedSinceToken <= 0) {
    return { isStalled: false, intensity: 0 }
  }

  // 未达 stalled 阈值
  if (elapsedSinceToken < STALLED_THRESHOLD_MS) {
    return { isStalled: false, intensity: 0 }
  }

  // stalled 已触发
  const fadeElapsed = elapsedSinceToken - STALLED_THRESHOLD_MS
  const rawIntensity = Math.min(1, fadeElapsed / STALLED_FADE_DURATION_MS)

  // reduced-motion: 立即满强度
  const intensity = reducedMotion ? 1 : rawIntensity

  return { isStalled: true, intensity }
}

/** stalled 渐变红 hook。
 *
 *  参数：
 *    - lastTokenAt: 最近一次 token 时间戳（0 表示未开始）
 *    - hasActiveTools: 是否有活跃 tool（true 时不判定 stalled）
 *
 *  返回：
 *    - isStalled: 是否进入 stalled 状态
 *    - intensity: 0..1 渐变强度（reduced-motion 时立即 1） */
export function useStalledAnimation(
  lastTokenAt: number,
  hasActiveTools: boolean,
): StalledAnimationState {
  // 消费共享时钟 tick —— 触发重算 intensity
  useClock()

  return computeStalledIntensity(
    lastTokenAt,
    hasActiveTools,
    Date.now(),
    REDUCED_MOTION,
  )
}
