/** Tests for RuntimeInspector 内容行（Depthline P2）。
 *
 *  formatRuntimeInspectorLines 为无 ANSI 纯函数；验证 RightRail 能力
 *  迁移不丢失：state / round / context / cache / gates / evidence / patches / tools。
 */

import { describe, expect, test } from "bun:test"
import { formatRuntimeInspectorLines } from "../../src/tui/components/overlays/RuntimeInspector"
import type { RightRailData } from "../../src/tui/state/selectors"

function baseData(overrides: Partial<RightRailData> = {}): RightRailData {
  return {
    round: 3,
    contextTokens: 18_420,
    contextMax: 128_000,
    cacheHitRate: 86,
    cacheHits: [],
    rippleFindings: [],
    toolHistory: [],
    taskProgress: { done: 0, total: 0, current: "" },
    runtime: {
      ripplePhase: "idle",
      rippleFindings: [],
      gateSummary: { total: 0, pass: 0, block: 0, warn: 0, skip: 0 },
      evidenceSummary: { total: 0, passed: 0, failed: 0, blocked: 0, running: 0, skipped: 0 },
      patchSummary: { total: 0, proposed: 0, committed: 0, rolledBack: 0 },
      activeTools: 0,
    },
    ...overrides,
  }
}

describe("formatRuntimeInspectorLines", () => {
  test("基础行：state / round / context / cache", () => {
    const lines = formatRuntimeInspectorLines(baseData(), "executing", false, "")
    const texts = lines.map(l => l.text)
    expect(texts[0]).toBe("state     executing")
    expect(texts[1]).toBe("round     3")
    expect(texts[2]).toBe("context   18,420 / 128,000")
    expect(texts[3]).toBe("cache     86%")
  })

  test("idle 时 state 显示 idle", () => {
    const lines = formatRuntimeInspectorLines(baseData(), "ready", true, "")
    expect(lines[0]!.text).toBe("state     idle")
  })

  test("errorLine 优先于 running/idle", () => {
    const lines = formatRuntimeInspectorLines(baseData(), "executing", false, "gate blocked")
    expect(lines[0]!.text).toContain("error gate blocked")
  })

  test("gates/evidence/patches 汇总行", () => {
    const data = baseData({
      runtime: {
        ...baseData().runtime,
        gateSummary: { total: 5, pass: 4, block: 0, warn: 1, skip: 0 },
        evidenceSummary: { total: 7, passed: 6, failed: 1, blocked: 0, running: 0, skipped: 0 },
        patchSummary: { total: 2, proposed: 0, committed: 2, rolledBack: 0 },
      },
    })
    const texts = formatRuntimeInspectorLines(data, "done", true, "").map(l => l.text)
    expect(texts).toContain("gates     4 passed · 0 blocked · 1 warning")
    expect(texts).toContain("evidence  6 accepted · 1 failed")
    expect(texts).toContain("patches   2 committed")
  })

  test("无 gates/evidence/patches 时不输出对应行", () => {
    const texts = formatRuntimeInspectorLines(baseData(), "ready", true, "").map(l => l.text)
    expect(texts.some(t => t.startsWith("gates"))).toBe(false)
    expect(texts.some(t => t.startsWith("evidence"))).toBe(false)
    expect(texts.some(t => t.startsWith("patches"))).toBe(false)
  })

  test("recent tools 只显示最近 4 条", () => {
    const toolHistory = [
      { name: "read", status: "done" as const },
      { name: "grep", status: "done" as const },
      { name: "edit", status: "done" as const },
      { name: "test", status: "running" as const },
      { name: "search", status: "error" as const },
    ]
    const lines = formatRuntimeInspectorLines(baseData({ toolHistory }), "executing", false, "")
    const toolLines = lines.filter(l => l.indent === 2)
    expect(toolLines.length).toBe(4)
    expect(toolLines[0]!.text).toBe("✓ grep")
    expect(toolLines[3]!.text).toBe("✗ search")
  })

  test("无工具历史时不输出 recent tools 段", () => {
    const texts = formatRuntimeInspectorLines(baseData(), "ready", true, "").map(l => l.text)
    expect(texts.some(t => t === "recent tools")).toBe(false)
  })
})
