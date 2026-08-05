/** Golden matrix（Depthline P5）。
 *
 *  场景 × 尺寸 × glyph 主题 → 无 ANSI 呈现文本快照。
 *
 *  场景：idle / streaming / tool-running / tool-completed / blocked-gate /
 *        permission / clarification / command-shelf / long-cjk / runtime-inspector
 *  尺寸：50×20 / 80×24 / 100×30 / 140×40
 *  glyph：ASCII（默认）/ Unicode 抽查
 *
 *  生成：ORCANA_GOLDEN_WRITE=1 bun test tests/tui/golden.test.ts
 */

import { describe, expect, test } from "bun:test"
import { readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { TuiState } from "../../src/tui/state/types"
import { TuiStore } from "../../src/tui/state/tui-store"
import { presentState, type GoldenOptions } from "../../src/tui/presentation/golden"

const GOLDEN_DIR = join(import.meta.dir, "golden")

const SIZES: Array<[number, number]> = [[50, 20], [80, 24], [100, 30], [140, 40]]

function freshStore(): TuiStore {
  const store = new TuiStore()
  store.dispatch({ type: "session.started", sessionId: "s1", repoRoot: "/home/user/orcana-runtime", provider: "anthropic", model: "claude-sonnet" })
  return store
}

// ── 场景构建 ──

function buildScenario(name: string): TuiState {
  const store = freshStore()
  switch (name) {
    case "idle":
      break
    case "streaming":
      store.dispatch({ type: "user.message", text: "帮我重构重试策略" })
      store.dispatch({ type: "assistant.delta", text: "我先检查当前错误契约和工具执行路径，然后拆分可重试错误与权限拒绝。" })
      break
    case "tool-running":
      store.dispatch({ type: "user.message", text: "实现新的 retry policy" })
      store.dispatch({ type: "assistant.delta", text: "开始检查执行路径。" })
      store.dispatch({ type: "tool.started", id: "t1", tool: "read" })
      store.dispatch({ type: "ui.event_message", kind: "tool", text: "read: src/runtime/retry-policy.ts", minIntervalMs: 0 })
      break
    case "tool-completed":
      store.dispatch({ type: "user.message", text: "实现新的 retry policy" })
      store.dispatch({ type: "ui.event_message", kind: "tool", text: "read: src/runtime/retry-policy.ts", minIntervalMs: 0 })
      store.dispatch({ type: "ui.event_message", kind: "tool", text: "edit: src/runtime/retry-policy.ts +84 -21", minIntervalMs: 0 })
      store.dispatch({ type: "ui.event_message", kind: "tool", text: "test: tests/tool-retry.test.ts 18 passed", minIntervalMs: 0 })
      store.dispatch({ type: "assistant.final", text: "已完成 retry policy 重构。" })
      store.dispatch({ type: "gate.result", gate: "write_gate", status: "pass" })
      store.dispatch({ type: "evidence.added", kind: "test", status: "passed", summary: "18 tests", txId: "tx1" })
      store.dispatch({ type: "patch.committed", txId: "tx1", files: ["src/runtime/retry-policy.ts"] })
      store.dispatch({ type: "ui.done", done: true })
      break
    case "blocked-gate":
      store.dispatch({ type: "user.message", text: "提交高风险变更" })
      store.dispatch({ type: "assistant.final", text: "变更被门禁拦截。" })
      store.dispatch({ type: "gate.result", gate: "risk_gate", status: "block", reason: "writable-root" })
      store.dispatch({ type: "evidence.added", kind: "test", status: "failed", summary: "3 tests failed", txId: "tx2" })
      store.dispatch({ type: "ui.error_line", text: "gate blocked: writable-root" })
      store.dispatch({ type: "ui.done", done: true })
      break
    case "permission":
      store.dispatch({ type: "user.question", question: "允许写入 src/runtime/retry-policy.ts？", options: [{ label: "允许一次" }, { label: "允许本次会话" }] })
      break
    case "clarification":
      store.dispatch({
        type: "clarification.ready",
        data: {
          marker: "[clarification]",
          originalPrompt: "实现重试策略",
          questions: [{ id: "q1", title: "选择实现方式？", options: [{ key: "A", label: "独立模块", recommended: true }, { key: "B", label: "内联重构" }] }],
          extraPrompt: "",
          rawText: "",
        },
      })
      break
    case "command-shelf":
      store.dispatch({ type: "user.message", text: "打开命令菜单" })
      break
    case "long-cjk":
      store.dispatch({ type: "user.message", text: "请分析这个长文本的性能影响" })
      store.dispatch({ type: "assistant.final", text: "这是一个非常长的中文回答，用来验证 CJK 宽字符在窄终端下的换行与截断行为是否稳定，同时验证 Depthline 呈现在混合宽度文本下不会发生视觉抖动或行宽溢出。" })
      store.dispatch({ type: "ui.done", done: true })
      break
    case "runtime-inspector":
      store.dispatch({ type: "user.message", text: "检查运行状态" })
      store.dispatch({ type: "assistant.final", text: "运行状态如下。" })
      store.dispatch({ type: "gate.result", gate: "write_gate", status: "pass" })
      store.dispatch({ type: "evidence.added", kind: "test", status: "passed", summary: "18 tests", txId: "tx1" })
      store.dispatch({ type: "patch.committed", txId: "tx1", files: ["src/a.ts"] })
      store.dispatch({ type: "ui.done", done: true })
      break
    default:
      throw new Error(`unknown scenario: ${name}`)
  }
  return store.getState()
}

const SCENARIOS = [
  "idle", "streaming", "tool-running", "tool-completed", "blocked-gate",
  "permission", "clarification", "command-shelf", "long-cjk", "runtime-inspector",
] as const

function scenarioOptions(name: string, cols: number): GoldenOptions {
  const opts: GoldenOptions = { cols, rows: 24 }
  if (name === "command-shelf") opts.hintContext = "CommandShelf"
  if (name === "runtime-inspector") opts.overlay = "inspector"
  return opts
}

function goldenText(name: string, cols: number, rows: number, unicode: boolean): string {
  const prev = process.env.ORCANA_TUI_UNICODE
  if (unicode) process.env.ORCANA_TUI_UNICODE = "1"
  else delete process.env.ORCANA_TUI_UNICODE
  try {
    const state = buildScenario(name)
    return presentState(state, { ...scenarioOptions(name, cols), rows })
  } finally {
    if (prev === undefined) delete process.env.ORCANA_TUI_UNICODE
    else process.env.ORCANA_TUI_UNICODE = prev
  }
}

function goldenPath(name: string, cols: number, rows: number, unicode: boolean): string {
  const suffix = unicode ? ".unicode" : ""
  return join(GOLDEN_DIR, `${name}-${cols}x${rows}${suffix}.txt`)
}

const WRITE = process.env.ORCANA_GOLDEN_WRITE === "1"

describe("golden matrix", () => {
  test("全部场景 × 尺寸快照一致（ASCII）", () => {
    for (const name of SCENARIOS) {
      for (const [cols, rows] of SIZES) {
        const text = goldenText(name, cols, rows, false)
        const file = goldenPath(name, cols, rows, false)
        if (WRITE) {
          mkdirSync(GOLDEN_DIR, { recursive: true })
          writeFileSync(file, text + "\n")
          continue
        }
        const expected = readFileSync(file, "utf8").replace(/\n$/, "")
        expect(text, `${name}@${cols}x${rows}`).toBe(expected)
      }
    }
  })

  test("unicode 抽查：streaming + tool-completed", () => {
    for (const name of ["streaming", "tool-completed"]) {
      for (const [cols, rows] of [[80, 24], [140, 40]] as Array<[number, number]>) {
        const text = goldenText(name, cols, rows, true)
        const file = goldenPath(name, cols, rows, true)
        if (WRITE) {
          mkdirSync(GOLDEN_DIR, { recursive: true })
          writeFileSync(file, text + "\n")
          continue
        }
        const expected = readFileSync(file, "utf8").replace(/\n$/, "")
        expect(text, `${name}@${cols}x${rows} unicode`).toBe(expected)
      }
    }
  })

  test("golden 文本无 ANSI 转义", () => {
    const text = goldenText("tool-completed", 80, 24, true)
    expect(text).not.toMatch(/\u001b\[/)
  })
})
