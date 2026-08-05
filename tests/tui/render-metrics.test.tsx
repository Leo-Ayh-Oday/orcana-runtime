/** Tests for render-metrics（Depthline P1 性能基线 + render 门禁）。
 *
 *  覆盖：
 *    1. 默认（ORCANA_TUI_PROFILE 未设置）零开销：计数器保持 0
 *    2. ORCANA_TUI_PROFILE=1 时计数生效
 *    3. 定时器登记/注销（idle 2s → activeTimers = 0 的机制层）
 *    4. FormattedLineCache miss 计数：100 个 delta 只 format 最后一条消息
 *    5. useLocalTick 集成：mount → 1 timer；暂停/卸载 → 0 timer
 *    6. AppShell idle 渲染不创建任何自建 timer
 */

import { describe, expect, test } from "bun:test"
import React from "react"
import { render, Text } from "ink"
import { PassThrough } from "node:stream"
import { renderMetrics, profilingEnabled } from "../../src/tui/render-metrics"
import { useLocalTick } from "../../src/tui/thinking/useLocalTick"
import { FormattedLineCache } from "../../src/tui/components/Scrollback"
import type { TuiMessage } from "../../src/tui/state/types"

function mockStdout(): PassThrough & { columns: number; rows: number } {
  const out = new PassThrough() as PassThrough & { columns: number; rows: number }
  out.columns = 80
  out.rows = 24
  return out
}

function makeMsg(id: string, text: string): TuiMessage {
  return { id, role: "assistant" as const, text, createdAt: 0 }
}

// ── 默认零开销 ──

describe("render-metrics: disabled by default", () => {
  test("profilingEnabled() is false without ORCANA_TUI_PROFILE", () => {
    delete process.env.ORCANA_TUI_PROFILE
    expect(profilingEnabled()).toBe(false)
  })

  test("counters stay zero when disabled", () => {
    delete process.env.ORCANA_TUI_PROFILE
    renderMetrics.reset()
    renderMetrics.incAppShellRender()
    renderMetrics.incTranscriptRender()
    renderMetrics.incMessageFormat()
    renderMetrics.incSelectorNotification()
    renderMetrics.trackTimer(1)
    const s = renderMetrics.snapshot()
    expect(s.appShellRenders).toBe(0)
    expect(s.transcriptRenders).toBe(0)
    expect(s.messageFormats).toBe(0)
    expect(s.selectorNotifications).toBe(0)
    expect(s.activeTimers).toBe(0)
  })
})

// ── 启用时计数 ──

describe("render-metrics: enabled", () => {
  test("counters increment and reset", () => {
    process.env.ORCANA_TUI_PROFILE = "1"
    try {
      renderMetrics.reset()
      renderMetrics.incAppShellRender()
      renderMetrics.incTranscriptRender()
      renderMetrics.incMessageFormat()
      expect(renderMetrics.snapshot()).toEqual({
        appShellRenders: 1,
        transcriptRenders: 1,
        messageFormats: 1,
        selectorNotifications: 0,
        activeTimers: 0,
      })
      renderMetrics.reset()
      expect(renderMetrics.snapshot().appShellRenders).toBe(0)
    } finally {
      delete process.env.ORCANA_TUI_PROFILE
      renderMetrics.reset()
    }
  })

  test("timer registry: track/untrack affects activeTimers", () => {
    process.env.ORCANA_TUI_PROFILE = "1"
    try {
      renderMetrics.reset()
      const id = { marker: 1 }
      renderMetrics.trackTimer(id)
      expect(renderMetrics.activeTimerCount()).toBe(1)
      renderMetrics.trackTimer(id) // 幂等（Set）
      expect(renderMetrics.activeTimerCount()).toBe(1)
      renderMetrics.untrackTimer(id)
      expect(renderMetrics.activeTimerCount()).toBe(0)
    } finally {
      delete process.env.ORCANA_TUI_PROFILE
      renderMetrics.reset()
    }
  })
})

// ── FormattedLineCache format 计数（100 delta 门禁） ──

describe("FormattedLineCache format count (100-delta gate)", () => {
  test("100 deltas on one message: exactly one format per delta, cache hits are free", () => {
    process.env.ORCANA_TUI_PROFILE = "1"
    try {
      renderMetrics.reset()
      const cache = new FormattedLineCache()
      // 既有消息先缓存一次
      cache.getOrCompute(makeMsg("stable", "committed"), 80, "done")
      const afterSeed = renderMetrics.snapshot().messageFormats
      expect(afterSeed).toBe(1)

      // 100 次 delta：每次只重算最后一条增长消息
      for (let i = 1; i <= 100; i++) {
        cache.getOrCompute(makeMsg("stream", "a".repeat(i)), 80, "streaming")
      }
      const afterStream = renderMetrics.snapshot().messageFormats
      expect(afterStream - afterSeed).toBe(100)

      // 稳定消息再读 50 次：cache hit，零 format
      for (let i = 0; i < 50; i++) {
        cache.getOrCompute(makeMsg("stable", "committed"), 80, "done")
      }
      expect(renderMetrics.snapshot().messageFormats).toBe(afterStream)
    } finally {
      delete process.env.ORCANA_TUI_PROFILE
      renderMetrics.reset()
    }
  })
})

// ── useLocalTick timer 生命周期 ──

describe("useLocalTick timer lifecycle", () => {
  test("mount with interval → 1 active timer; pause (null) → 0", async () => {
    process.env.ORCANA_TUI_PROFILE = "1"
    try {
      renderMetrics.reset()
      const stdout = mockStdout()
      const App = React.memo(function App({ intervalMs }: { intervalMs: number | null }) {
        const tick = useLocalTick(intervalMs)
        return <Text>{String(tick)}</Text>
      })
      const { unmount, rerender } = render(<App intervalMs={60} />, { stdout })
      expect(renderMetrics.activeTimerCount()).toBe(1)

      rerender(<App intervalMs={null} />)
      expect(renderMetrics.activeTimerCount()).toBe(0)

      unmount()
      expect(renderMetrics.activeTimerCount()).toBe(0)
    } finally {
      delete process.env.ORCANA_TUI_PROFILE
      renderMetrics.reset()
    }
  })
})
