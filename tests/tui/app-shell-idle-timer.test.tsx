/** Tests for P1 idle-timer gate: AppShell 空闲渲染不创建任何自建 timer。
 *
 *  门禁：idle 2 秒 → 应用自建 repeating timer = 0。
 *  机制层由 render-metrics + useLocalTick 覆盖；本文件验证空闲界面
 *  整棵渲染路径（HeaderBar / EmptySurface / Scrollback / ThinkingDock
 *  hidden / PlanPanel null / ComposerFrame）不产生定时器。
 */

import { describe, expect, test } from "bun:test"
import React from "react"
import { render } from "ink"
import { PassThrough } from "node:stream"
import { renderMetrics } from "../../src/tui/render-metrics"
import { createInitialTuiState } from "../../src/tui/state/event-reducer"
import { AppShell, type InputChromeState } from "../../src/tui/components/AppShell"
import type { ScrollbackScrollState } from "../../src/tui/components/Scrollback"
import type { Runtime } from "../../src/runtime/bootstrap"

function mockStdout(): NodeJS.WriteStream {
  const out = new PassThrough() as PassThrough & { columns: number; rows: number }
  out.columns = 100
  out.rows = 30
  return out as unknown as NodeJS.WriteStream
}

const noop = () => {}

function idleScrollState(): ScrollbackScrollState {
  return { maxOffset: 0, normalizedOffset: 0, hiddenAbove: false, hiddenBelow: false }
}

const inputChrome: InputChromeState = { commandOpen: false, pasteCount: 0, textRows: 1 }

describe("AppShell idle render (P1 gate: idle 2s → activeTimers = 0)", () => {
  test("idle AppShell creates no self-managed timers", async () => {
    process.env.ORCANA_TUI_PROFILE = "1"
    try {
      renderMetrics.reset()
      const runtime = { version: "0.0.0-test", tools: [] } as unknown as Runtime
      const state = createInitialTuiState()
      const stdout = mockStdout()
      const { unmount } = render(
        <AppShell
          state={state}
          runtime={runtime}
          scrollOffset={0}
          scrollState={idleScrollState()}
          onScrollState={noop}
          showStartup={false}
          clarification={null}
          inputChrome={inputChrome}
          submit={noop}
          answerClarification={noop}
          moveClarificationSelection={noop}
          cancelClarification={noop}
          scrollUp={noop}
          scrollDown={noop}
          setInputChrome={noop}
          overlay={{ kind: "none" }}
          thinkingEffort="auto"
        />,
        { stdout },
      )
      // 等待渲染提交
      await new Promise(resolve => setTimeout(resolve, 50))
      // idle 2 秒后仍无自建 timer
      await new Promise(resolve => setTimeout(resolve, 2_000))
      expect(renderMetrics.activeTimerCount()).toBe(0)
      unmount()
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(renderMetrics.activeTimerCount()).toBe(0)
    } finally {
      delete process.env.ORCANA_TUI_PROFILE
      renderMetrics.reset()
    }
  })
})
