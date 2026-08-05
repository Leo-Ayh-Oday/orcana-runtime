/** Tests for TranscriptViewport（Depthline P4）。
 *
 *  覆盖：
 *    - blockToLines：collapsed 只出摘要；expanded 出详情（缩进）；truncated 摘要+前2条
 *    - 折叠标记（unicode ▸/▾；ascii +/-）
 *    - 块间空行规则（user/assistant 后空行，工具组间不空行）
 *    - BlockLineCache：模式/文本变化 miss，其余命中
 *    - 选中高亮标记
 */

import { describe, expect, test } from "bun:test"
import { blockToLines, buildViewportLines, BlockLineCache } from "../../src/tui/components/TranscriptViewport"
import type { TranscriptBlock, TranscriptViewState, BlockDisplayMode } from "../../src/tui/presentation/block-model"

function view(modes: Record<string, BlockDisplayMode> = {}, selected: string | null = null): TranscriptViewState {
  return { selectedBlockId: selected, displayModes: new Map(Object.entries(modes)) as ReadonlyMap<string, BlockDisplayMode> }
}

function toolGroup(overrides: Partial<TranscriptBlock> = {}): TranscriptBlock {
  return {
    id: "g-1",
    kind: "tool-group",
    lifecycle: "done",
    selectable: true,
    defaultMode: "collapsed",
    summary: ["3 tool calls"],
    details: ["read: src/a.ts", "edit: src/b.ts", "test: all"],
    ...overrides,
  }
}

describe("blockToLines", () => {
  function withUnicode<T>(fn: () => T): T {
    const prev = process.env.ORCANA_TUI_UNICODE
    process.env.ORCANA_TUI_UNICODE = "1"
    try {
      return fn()
    } finally {
      if (prev === undefined) delete process.env.ORCANA_TUI_UNICODE
      else process.env.ORCANA_TUI_UNICODE = prev
    }
  }

  test("collapsed：只渲染摘要行 + 折叠标记", () => {
    withUnicode(() => {
      const lines = blockToLines(toolGroup(), "collapsed", false)
      expect(lines.length).toBe(1)
      expect(lines[0]!.text).toBe("3 tool calls")
      expect(lines[0]!.marker).toBe("▸")
    })
  })

  test("expanded：摘要 + 全部详情（缩进 1）", () => {
    withUnicode(() => {
      const lines = blockToLines(toolGroup(), "expanded", false)
      expect(lines.length).toBe(4)
      expect(lines[0]!.marker).toBe("▾")
      expect(lines[1]!.indent).toBe(1)
      expect(lines[3]!.text).toBe("test: all")
    })
  })

  test("truncated：摘要 + 前 2 条详情 + 更多提示", () => {
    const lines = blockToLines(toolGroup({ lifecycle: "running" }), "truncated", false)
    expect(lines.length).toBe(4)
    expect(lines[3]!.text).toContain("+1 more")
  })

  test("truncated：详情 ≤2 条时无 more 提示", () => {
    const lines = blockToLines(toolGroup({ details: ["read: a", "edit: b"] }), "truncated", false)
    expect(lines.length).toBe(3)
    expect(lines[2]!.text).toBe("edit: b")
  })

  test("selected：摘要行带 selected 标记", () => {
    const lines = blockToLines(toolGroup(), "collapsed", true)
    expect(lines[0]!.selected).toBe(true)
  })

  test("ASCII 主题用 +/- 折叠标记", () => {
    const prev = process.env.ORCANA_TUI_UNICODE
    process.env.ORCANA_TUI_UNICODE = ""
    try {
      const lines = blockToLines(toolGroup(), "collapsed", false)
      expect(lines[0]!.marker).toBe("+")
    } finally {
      if (prev === "1") process.env.ORCANA_TUI_UNICODE = "1"
      else delete process.env.ORCANA_TUI_UNICODE
    }
  })
})

describe("buildViewportLines", () => {
  test("user/assistant 块后空一行，工具组间不空行", () => {
    const cache = new BlockLineCache()
    const blocks: TranscriptBlock[] = [
      { id: "b-user", kind: "user", lifecycle: "done", selectable: false, defaultMode: "expanded", summary: ["hi"], details: [] },
      { id: "b-assist", kind: "assistant", lifecycle: "done", selectable: false, defaultMode: "expanded", summary: ["ok"], details: [] },
      toolGroup({ id: "g-1" }),
      toolGroup({ id: "g-2" }),
    ]
    const lines = buildViewportLines(cache, blocks, view(), 80)
    // user(1) + spacer(1) + assistant(1) + spacer(1) + tool(1) + tool(1) = 6
    expect(lines.length).toBe(6)
    expect(lines[1]!.text).toBe("")
    expect(lines[3]!.text).toBe("")
  })

  test("视图模式覆盖默认：展开的组渲染详情", () => {
    const cache = new BlockLineCache()
    const blocks: TranscriptBlock[] = [toolGroup({ id: "g-1" })]
    const lines = buildViewportLines(cache, blocks, view({ "g-1": "expanded" }), 80)
    expect(lines.length).toBe(4)
  })

  test("BlockLineCache：同键命中同一引用，模式变化 miss", () => {
    const cache = new BlockLineCache()
    const blocks: TranscriptBlock[] = [toolGroup({ id: "g-1" })]
    const first = buildViewportLines(cache, blocks, view(), 80)
    const second = buildViewportLines(cache, blocks, view(), 80)
    expect(second[0]).toBe(first[0])
    expect(cache.stats().size).toBe(1)

    buildViewportLines(cache, blocks, view({ "g-1": "expanded" }), 80)
    expect(cache.stats().size).toBe(1) // 同一 block，覆盖旧条目
  })

  test("流式文本变化：只重算变化的块（缓存命中其余）", () => {
    const cache = new BlockLineCache()
    const blocks1: TranscriptBlock[] = [
      { id: "b-user", kind: "user", lifecycle: "done", selectable: false, defaultMode: "expanded", summary: ["hi"], details: [] },
      toolGroup({ id: "g-1" }),
    ]
    const lines1 = buildViewportLines(cache, blocks1, view(), 80)

    const blocks2: TranscriptBlock[] = [
      blocks1[0]!,
      { ...toolGroup({ id: "g-1" }), summary: ["4 tool calls"], details: ["read: a", "edit: b", "test: all", "grep: x"] },
    ]
    const lines2 = buildViewportLines(cache, blocks2, view(), 80)
    // user 块行引用不变（缓存命中），工具组行变化
    expect(lines2[0]).toBe(lines1[0])
    expect(lines2[2]!.text).toBe("4 tool calls")
  })
})
