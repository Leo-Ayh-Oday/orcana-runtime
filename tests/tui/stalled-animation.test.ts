/** Tests for PR-10: stalled 渐变红机制。
 *
 *  覆盖：
 *    1. interpolateColor: hex 颜色线性插值
 *    2. computeStalledIntensity: stalled 阈值 + 2s 线性渐变
 *    3. reduced-motion: 立即满强度
 *    4. hasActiveTools 抑制 stalled
 *    5. 新 token 重置（intensity 回到 0）
 */

import { describe, expect, test } from "bun:test"
import {
  interpolateColor,
  computeStalledIntensity,
  STALLED_FADE_DURATION_MS,
  STALLED_THRESHOLD_MS,
} from "../../src/tui/hooks/use-stalled-animation"

// ── interpolateColor ──

describe("interpolateColor (PR-10)", () => {
  test("intensity=0 returns normalColor", () => {
    expect(interpolateColor("#38BDF8", "#FB7185", 0)).toBe("#38bdf8")
  })

  test("intensity=1 returns errorColor", () => {
    expect(interpolateColor("#38BDF8", "#FB7185", 1)).toBe("#fb7185")
  })

  test("intensity=0.5 returns midpoint", () => {
    // #38BDF8 (56,189,248) ↔ #FB7185 (251,113,133)
    // midpoint: (154, 151, 191) = #9A97BF
    expect(interpolateColor("#38BDF8", "#FB7185", 0.5)).toBe("#9a97bf")
  })

  test("intensity < 0 clamped to 0", () => {
    expect(interpolateColor("#38BDF8", "#FB7185", -0.5)).toBe("#38bdf8")
  })

  test("intensity > 1 clamped to 1", () => {
    expect(interpolateColor("#38BDF8", "#FB7185", 1.5)).toBe("#fb7185")
  })

  test("accepts hex without # prefix", () => {
    expect(interpolateColor("38BDF8", "FB7185", 0)).toBe("#38bdf8")
    expect(interpolateColor("38BDF8", "FB7185", 1)).toBe("#fb7185")
  })

  test("accepts lowercase hex", () => {
    expect(interpolateColor("#38bdf8", "#fb7185", 1)).toBe("#fb7185")
  })

  test("invalid normal color → fallback to normal", () => {
    expect(interpolateColor("not-a-color", "#FB7185", 0.5)).toBe("not-a-color")
  })

  test("invalid error color → fallback to normal", () => {
    expect(interpolateColor("#38BDF8", "xxx", 0.5)).toBe("#38BDF8")
  })

  test("extremes: black to white at 0.5 = gray", () => {
    expect(interpolateColor("#000000", "#FFFFFF", 0.5)).toBe("#808080")
  })
})

// ── computeStalledIntensity ──

describe("computeStalledIntensity (PR-10)", () => {
  const NOW = 10_000_000 // 固定参考时间戳

  test("lastTokenAt=0 (未开始) → not stalled, intensity=0", () => {
    const r = computeStalledIntensity(0, false, NOW, false)
    expect(r.isStalled).toBe(false)
    expect(r.intensity).toBe(0)
  })

  test("hasActiveTools=true → not stalled even if 3s+ passed", () => {
    const lastTokenAt = NOW - 5_000 // 5s 前
    const r = computeStalledIntensity(lastTokenAt, true, NOW, false)
    expect(r.isStalled).toBe(false)
    expect(r.intensity).toBe(0)
  })

  test("elapsed < 3s → not stalled", () => {
    const lastTokenAt = NOW - 2_999 // 2.999s 前
    const r = computeStalledIntensity(lastTokenAt, false, NOW, false)
    expect(r.isStalled).toBe(false)
    expect(r.intensity).toBe(0)
  })

  test("elapsed = 3s exactly → stalled, intensity=0 (fade 起点)", () => {
    const lastTokenAt = NOW - STALLED_THRESHOLD_MS
    const r = computeStalledIntensity(lastTokenAt, false, NOW, false)
    expect(r.isStalled).toBe(true)
    expect(r.intensity).toBe(0)
  })

  test("elapsed = 4s (1s into fade) → intensity=0.5", () => {
    const lastTokenAt = NOW - (STALLED_THRESHOLD_MS + 1_000)
    const r = computeStalledIntensity(lastTokenAt, false, NOW, false)
    expect(r.isStalled).toBe(true)
    expect(r.intensity).toBe(0.5)
  })

  test("elapsed = 5s (2s into fade) → intensity=1", () => {
    const lastTokenAt = NOW - (STALLED_THRESHOLD_MS + STALLED_FADE_DURATION_MS)
    const r = computeStalledIntensity(lastTokenAt, false, NOW, false)
    expect(r.isStalled).toBe(true)
    expect(r.intensity).toBe(1)
  })

  test("elapsed = 10s (5s past fade) → intensity=1 (capped)", () => {
    const lastTokenAt = NOW - 10_000
    const r = computeStalledIntensity(lastTokenAt, false, NOW, false)
    expect(r.isStalled).toBe(true)
    expect(r.intensity).toBe(1)
  })

  test("intensity 单调递增", () => {
    const values: number[] = []
    for (let dt = 3000; dt <= 5000; dt += 500) {
      values.push(computeStalledIntensity(NOW - dt, false, NOW, false).intensity)
    }
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]!)
    }
  })

  // ── reduced-motion ──

  test("reducedMotion: 立即 intensity=1 at 3s", () => {
    const lastTokenAt = NOW - STALLED_THRESHOLD_MS
    const r = computeStalledIntensity(lastTokenAt, false, NOW, true)
    expect(r.isStalled).toBe(true)
    expect(r.intensity).toBe(1) // 立即满强度
  })

  test("reducedMotion: 立即 intensity=1 even at 3.001s", () => {
    const lastTokenAt = NOW - (STALLED_THRESHOLD_MS + 1)
    const r = computeStalledIntensity(lastTokenAt, false, NOW, true)
    expect(r.intensity).toBe(1)
  })

  test("reducedMotion: not stalled if elapsed < 3s (motion 不影响阈值)", () => {
    const lastTokenAt = NOW - 1_000
    const r = computeStalledIntensity(lastTokenAt, false, NOW, true)
    expect(r.isStalled).toBe(false)
    expect(r.intensity).toBe(0)
  })

  // ── 新 token 重置 ──

  test("新 token 到达（now 重置为 lastTokenAt）→ intensity=0", () => {
    // 模拟 4s 前 token，然后 0.5s 前又来了一个 token
    const oldTokenAt = NOW - 4_000
    const newTokenAt = NOW - 500
    const r = computeStalledIntensity(newTokenAt, false, NOW, false)
    expect(r.isStalled).toBe(false)
    expect(r.intensity).toBe(0)
  })

  // ── 时间倒流/相等保护 ──

  test("now < lastTokenAt → not stalled", () => {
    const r = computeStalledIntensity(NOW + 1_000, false, NOW, false)
    expect(r.isStalled).toBe(false)
    expect(r.intensity).toBe(0)
  })

  test("now = lastTokenAt → not stalled", () => {
    const r = computeStalledIntensity(NOW, false, NOW, false)
    expect(r.isStalled).toBe(false)
    expect(r.intensity).toBe(0)
  })
})
