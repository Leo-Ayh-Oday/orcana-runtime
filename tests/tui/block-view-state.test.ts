/** Tests for block-view-state reducer（Depthline P4）。
 *
 *  覆盖（评审修正 #4）：
 *    - 折叠状态独立于派生结果（dispatch 后不被流式 delta 重置）
 *    - toggle/expand/collapse 语义
 *    - prune：已删除块清理显示状态 + 选中回退
 *    - 选中状态
 */

import { describe, expect, test } from "bun:test"
import {
  createInitialTranscriptViewState,
  reduceTranscriptViewState,
} from "../../src/tui/presentation/block-view-state"
import { displayModeFor, type TranscriptViewState, type BlockDisplayMode } from "../../src/tui/presentation/block-model"

function viewWith(modes: Record<string, BlockDisplayMode>, selected: string | null = null): TranscriptViewState {
  return {
    selectedBlockId: selected,
    displayModes: new Map(Object.entries(modes)) as ReadonlyMap<string, BlockDisplayMode>,
  }
}

describe("reduceTranscriptViewState", () => {
  test("toggle：collapsed → expanded → collapsed", () => {
    let v = createInitialTranscriptViewState()
    v = reduceTranscriptViewState(v, { type: "block.toggle", blockId: "b1" })
    expect(v.displayModes.get("b1")).toBe("expanded")
    v = reduceTranscriptViewState(v, { type: "block.toggle", blockId: "b1" })
    expect(v.displayModes.get("b1")).toBe("collapsed")
  })

  test("toggle：truncated → expanded", () => {
    let v = createInitialTranscriptViewState()
    v = reduceTranscriptViewState(v, { type: "block.toggle", blockId: "b1" })
    expect(v.displayModes.get("b1")).toBe("expanded")
  })

  test("expand / collapse 显式设置", () => {
    let v = createInitialTranscriptViewState()
    v = reduceTranscriptViewState(v, { type: "block.expand", blockId: "b1" })
    expect(v.displayModes.get("b1")).toBe("expanded")
    v = reduceTranscriptViewState(v, { type: "block.collapse", blockId: "b1" })
    expect(v.displayModes.get("b1")).toBe("collapsed")
  })

  test("displayModeFor：视图覆盖优先于默认模式", () => {
    const v = viewWith({ b1: "expanded" })
    expect(displayModeFor(v, { id: "b1", defaultMode: "collapsed" })).toBe("expanded")
    expect(displayModeFor(v, { id: "b2", defaultMode: "collapsed" })).toBe("collapsed")
  })

  test("prune：清理已删除块的显示状态，选中回退 null", () => {
    let v = viewWith({ b1: "expanded", b2: "collapsed" }, "b1")
    v = reduceTranscriptViewState(v, { type: "block.prune", liveIds: new Set(["b2", "b3"]) })
    expect(v.displayModes.has("b1")).toBe(false)
    expect(v.displayModes.get("b2")).toBe("collapsed")
    expect(v.selectedBlockId).toBeNull()
  })

  test("prune：存活选中保留", () => {
    let v = viewWith({ b2: "expanded" }, "b2")
    v = reduceTranscriptViewState(v, { type: "block.prune", liveIds: new Set(["b2", "b3"]) })
    expect(v.selectedBlockId).toBe("b2")
    expect(v.displayModes.get("b2")).toBe("expanded")
  })

  test("prune：无变化时返回同一引用（不触发重渲染）", () => {
    const v = viewWith({ b1: "expanded" }, "b1")
    const next = reduceTranscriptViewState(v, { type: "block.prune", liveIds: new Set(["b1", "b2"]) })
    expect(next).toBe(v)
  })

  test("select：切换选中块", () => {
    let v = createInitialTranscriptViewState()
    v = reduceTranscriptViewState(v, { type: "block.select", blockId: "b1" })
    expect(v.selectedBlockId).toBe("b1")
    v = reduceTranscriptViewState(v, { type: "block.select", blockId: null })
    expect(v.selectedBlockId).toBeNull()
  })
})
