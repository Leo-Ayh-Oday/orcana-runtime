/** Tests for deriveTranscriptBlocks（Depthline P4）。
 *
 *  覆盖：
 *    - 用户/正文/工具/计划/任务/系统块派生
 *    - 相邻工具事件归组（ToolGroup）；跨 user 边界不合并
 *    - 运行中工具组：仅最后一个 running → truncated；其余 done → collapsed
 *    - ExecutionSummaryBlock 来自结构化数组（gates/evidence/patches），非文本解析
 *    - 稳定 block id（流式增长不改变既有 id）
 */

import { describe, expect, test } from "bun:test"
import { TuiStore } from "../../src/tui/state/tui-store"
import { deriveTranscriptBlocks } from "../../src/tui/presentation/derive-blocks"
import type { TranscriptBlock } from "../../src/tui/presentation/block-model"
import type { TuiMessage } from "../../src/tui/state/types"

function makeStore(): TuiStore {
  return new TuiStore()
}

function kindOf(blocks: TranscriptBlock[], kind: string): TranscriptBlock[] {
  return blocks.filter(b => b.kind === kind)
}

describe("基础块派生", () => {
  test("user + assistant → UserBlock / AssistantBlock（expanded）", () => {
    const store = makeStore()
    store.dispatch({ type: "user.message", text: "hello" })
    store.dispatch({ type: "assistant.final", text: "world" })
    const blocks = deriveTranscriptBlocks(store.getState())
    const users = kindOf(blocks, "user")
    const assistants = kindOf(blocks, "assistant")
    expect(users.length).toBe(1)
    expect(users[0]!.summary).toEqual(["hello"])
    expect(assistants.length).toBe(1)
    expect(assistants[0]!.summary).toEqual(["world"])
    expect(assistants[0]!.defaultMode).toBe("expanded")
  })

  test("pending assistant → running / truncated", () => {
    const store = makeStore()
    store.dispatch({ type: "user.message", text: "hi" })
    store.dispatch({ type: "assistant.delta", text: "streaming" })
    const blocks = deriveTranscriptBlocks(store.getState())
    const assistant = kindOf(blocks, "assistant")[0]!
    expect(assistant.lifecycle).toBe("running")
    expect(assistant.defaultMode).toBe("truncated")
  })

  test("assistant.final → done / expanded；错误由 error 事件 SystemBlock 表达", () => {
    const store = makeStore()
    store.dispatch({ type: "user.message", text: "hi" })
    store.dispatch({ type: "assistant.final", text: "boom" })
    store.dispatch({ type: "ui.event_message", kind: "error", text: "boom", minIntervalMs: 0 })
    const blocks = deriveTranscriptBlocks(store.getState())
    const assistant = kindOf(blocks, "assistant")[0]!
    expect(assistant.lifecycle).toBe("done")
    expect(assistant.defaultMode).toBe("expanded")
    const system = kindOf(blocks, "system")[0]!
    expect(system.lifecycle).toBe("error")
  })

  test("turnId 按 user 消息计数", () => {
    const store = makeStore()
    store.dispatch({ type: "user.message", text: "q1" })
    store.dispatch({ type: "assistant.final", text: "a1" })
    store.dispatch({ type: "user.message", text: "q2" })
    store.dispatch({ type: "assistant.final", text: "a2" })
    const blocks = deriveTranscriptBlocks(store.getState())
    const users = kindOf(blocks, "user")
    expect(users[0]!.turnId).toBe("turn-1")
    expect(users[1]!.turnId).toBe("turn-2")
  })
})

describe("ToolGroup 归组", () => {
  test("相邻工具事件合并为一组（collapsed）", () => {
    const store = makeStore()
    store.dispatch({ type: "user.message", text: "do it" })
    store.dispatch({ type: "ui.event_message", kind: "tool", text: "read: src/a.ts", minIntervalMs: 0 })
    store.dispatch({ type: "ui.event_message", kind: "tool", text: "edit: src/b.ts", minIntervalMs: 0 })
    store.dispatch({ type: "ui.event_message", kind: "tool", text: "test: all", minIntervalMs: 0 })
    const blocks = deriveTranscriptBlocks(store.getState())
    const groups = kindOf(blocks, "tool-group")
    expect(groups.length).toBe(1)
    expect(groups[0]!.summary).toEqual(["3 tool calls"])
    expect(groups[0]!.details.length).toBe(3)
    expect(groups[0]!.defaultMode).toBe("collapsed")
    expect(groups[0]!.selectable).toBe(true)
  })

  test("user 边界不跨轮合并", () => {
    const store = makeStore()
    store.dispatch({ type: "user.message", text: "q1" })
    store.dispatch({ type: "ui.event_message", kind: "tool", text: "read: a", minIntervalMs: 0 })
    store.dispatch({ type: "assistant.final", text: "done 1" })
    store.dispatch({ type: "user.message", text: "q2" })
    store.dispatch({ type: "ui.event_message", kind: "tool", text: "read: b", minIntervalMs: 0 })
    store.dispatch({ type: "assistant.final", text: "done 2" })
    const blocks = deriveTranscriptBlocks(store.getState())
    expect(kindOf(blocks, "tool-group").length).toBe(2)
  })

  test("最后一个工具组 + 有 running 工具 → running / truncated", () => {
    const store = makeStore()
    store.dispatch({ type: "user.message", text: "q1" })
    store.dispatch({ type: "tool.started", id: "t1", tool: "read" })
    store.dispatch({ type: "ui.event_message", kind: "tool", text: "read: a", minIntervalMs: 0 })
    const blocks = deriveTranscriptBlocks(store.getState())
    const group = kindOf(blocks, "tool-group")[0]!
    expect(group.lifecycle).toBe("running")
    expect(group.defaultMode).toBe("truncated")
  })

  test("非最后一个工具组强制 done（running 只允许最后一个）", () => {
    const store = makeStore()
    store.dispatch({ type: "user.message", text: "q1" })
    store.dispatch({ type: "tool.started", id: "t1", tool: "read" })
    store.dispatch({ type: "ui.event_message", kind: "tool", text: "read: a", minIntervalMs: 0 })
    // 新轮次开始 → 该工具组不再是最后一个块，必须翻转为 done
    store.dispatch({ type: "user.message", text: "q2" })
    store.dispatch({ type: "assistant.final", text: "more" })
    store.dispatch({ type: "tool.finished", id: "t1", ok: true })
    const blocks = deriveTranscriptBlocks(store.getState())
    const groups = kindOf(blocks, "tool-group")
    expect(groups.length).toBe(1)
    expect(groups[0]!.lifecycle).toBe("done")
  })
})

describe("ExecutionSummaryBlock（结构化数组）", () => {
  test("gates/evidence/patches → 尾部汇总块", () => {
    const store = makeStore()
    store.dispatch({ type: "user.message", text: "q1" })
    store.dispatch({ type: "assistant.final", text: "a1" })
    // 直接构造结构化事件（reducer 层面）
    store.dispatch({ type: "gate.result", gate: "write_gate", status: "pass" })
    store.dispatch({ type: "evidence.added", kind: "test", status: "passed", summary: "18 tests", txId: "tx1" })
    store.dispatch({ type: "patch.committed", txId: "tx1", files: ["src/a.ts"] })
    const blocks = deriveTranscriptBlocks(store.getState())
    const summary = kindOf(blocks, "execution-summary")[0]!
    expect(summary.defaultMode).toBe("collapsed")
    expect(summary.summary[0]).toContain("1 gate")
    expect(summary.summary[0]).toContain("1 evidence")
    expect(summary.summary[0]).toContain("1 patch")
    expect(summary.details.length).toBe(3)
    // 不解析消息文本：细节来自结构化字段
    expect(summary.details[0]).toContain("write_gate")
  })

  test("无 gates/evidence/patches 时不生成汇总块", () => {
    const store = makeStore()
    store.dispatch({ type: "user.message", text: "q1" })
    const blocks = deriveTranscriptBlocks(store.getState())
    expect(kindOf(blocks, "execution-summary").length).toBe(0)
  })
})

describe("空轮守卫", () => {
  test("空文本且已结束的 assistant 不渲染空气泡", () => {
    const store = makeStore()
    store.dispatch({ type: "user.message", text: "q1" })
    // 空轮：无 delta，直接 final 空文本（empty_round 路径）
    store.dispatch({ type: "assistant.final", text: "" })
    const blocks = deriveTranscriptBlocks(store.getState())
    expect(kindOf(blocks, "assistant").length).toBe(0)
  })

  test("pending 中的空 assistant 仍渲染（思考中占位）", () => {
    const store = makeStore()
    store.dispatch({ type: "user.message", text: "q2" })
    const blocks = deriveTranscriptBlocks(store.getState())
    const assistants = kindOf(blocks, "assistant")
    expect(assistants.length).toBe(1)
    expect(assistants[0]!.lifecycle).toBe("running")
  })

  test("有文本的正常回复不受影响", () => {
    const store = makeStore()
    store.dispatch({ type: "user.message", text: "q3" })
    store.dispatch({ type: "assistant.final", text: "answer" })
    expect(kindOf(deriveTranscriptBlocks(store.getState()), "assistant").length).toBe(1)
  })
})

describe("稳定 ID", () => {
  test("流式增长：既有块的 id 不变", () => {
    const store = makeStore()
    store.dispatch({ type: "user.message", text: "q1" })
    store.dispatch({ type: "assistant.delta", text: "a" })
    const before = deriveTranscriptBlocks(store.getState()).map(b => b.id)
    store.dispatch({ type: "assistant.delta", text: "ab" })
    store.dispatch({ type: "assistant.delta", text: "abc" })
    const after = deriveTranscriptBlocks(store.getState()).map(b => b.id)
    expect(after.slice(0, before.length)).toEqual(before)
  })
})

describe("系统块", () => {
  test("activity → system collapsed；error → system expanded", () => {
    const store = makeStore()
    store.dispatch({ type: "ui.event_message", kind: "activity", text: "queued message #1", minIntervalMs: 0 })
    store.dispatch({ type: "ui.event_message", kind: "error", text: "boom", minIntervalMs: 0 })
    const blocks = deriveTranscriptBlocks(store.getState())
    const systems = kindOf(blocks, "system")
    expect(systems[0]!.lifecycle).toBe("done")
    expect(systems[0]!.defaultMode).toBe("collapsed")
    expect(systems[1]!.lifecycle).toBe("error")
    expect(systems[1]!.defaultMode).toBe("expanded")
  })
})
