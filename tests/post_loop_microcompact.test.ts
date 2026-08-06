/** RC-18 K5 / K25 / K26 / K27 / K28 — post-loop microcompact defect fixes.
 *
 * 覆盖：
 *  - K26 历史压缩按实际 assistant 轮次算 cut（而非 messages.length - keepRecentRounds*2）
 *  - K27 历史压缩通过相邻 tool_use 块解析真实工具名（toolu_/call_ id 不再靠前缀猜）
 *  - K28 read_file 阈值 0 时前向/历史都不压缩（语义统一）
 *  - K25 is_error 结果前向/历史都不压缩（失败 Pin）
 *  - K5 可选 persist 钩子：压缩前持久化完整内容，placeholder 含 [Artifact: ref]
 */

import { describe, expect, test, beforeAll } from "bun:test"
import type { ProviderMessage } from "../src/provider/types"

// ── 两个独立模块实例（阈值由 env 决定，模块加载时计算）──────────────────────────
// pl         ：read_file=0（永不压缩）、shell=3000、web_fetch=5000 —— K28/K26/K25/K5
// plReadfile ：read_file=2000（可压缩）—— K27 需验证 read_file 在历史路径可被识别并压缩。
// 用 ?rf=2000 做 cache-bust，让第二次 import 拿到一个全新模块实例。
let pl!: typeof import("../src/agent/round/post-loop")
let plReadfile!: typeof import("../src/agent/round/post-loop")

beforeAll(async () => {
  process.env.ORCANA_READFILE_COMPACT_CHARS = "0"
  process.env.ORCANA_SHELL_COMPACT_CHARS = "3000"
  process.env.ORCANA_WEBFETCH_COMPACT_CHARS = "5000"
  pl = await import("../src/agent/round/post-loop")

  process.env.ORCANA_READFILE_COMPACT_CHARS = "2000"
  // 变量 specifier 触发 cache-bust（全新模块实例），同时避开 TS 对 query 后缀的静态解析。
  const freshSpecifier = "../src/agent/round/post-loop?rf=2000"
  plReadfile = (await import(freshSpecifier)) as typeof pl
})

// ── 构造 helpers ───────────────────────────────────────────────────────────

function toolUseBlock(tid: string, name: string, input: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "tool_use", id: tid, name, input }
}

function toolResultBlock(tid: string, content: string, isError = false): Record<string, unknown> {
  return { type: "tool_result", tool_use_id: tid, content, is_error: isError }
}

/** 在 user 消息里按 tool_use_id 精确查找 tool_result 当前内容（压缩会就地改写）。 */
function findToolResult(msgs: ProviderMessage[], tid: string): string | undefined {
  for (const m of msgs) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue
    for (const b of m.content) {
      const rec = b as Record<string, unknown>
      if (rec.type === "tool_result" && String(rec.tool_use_id ?? "") === tid) return String(rec.content ?? "")
    }
  }
  return undefined
}

/** 构建历史会话：oldRounds 轮（应被压缩）+ recentRounds 轮（应保留），每轮一个
 *  tool_use→tool_result，并穿插 extraUserPerRound 条纯文本 user 消息，模拟真实
 *  「user 消息远多于 assistant 消息」的分布。 */
function buildHistoricalMessages(opts: {
  oldRounds: number
  recentRounds: number
  toolName: string
  contentLen: number
  idPrefix: string
  extraUserPerRound?: number
  isErrorOld?: boolean
  isErrorRecent?: boolean
}): ProviderMessage[] {
  const { oldRounds, recentRounds, toolName, contentLen, idPrefix, extraUserPerRound = 0, isErrorOld = false, isErrorRecent = false } = opts
  const msgs: ProviderMessage[] = [{ role: "user", content: "initial task" }]
  for (let i = 0; i < oldRounds; i++) {
    const tid = `${idPrefix}_old${i}`
    msgs.push({ role: "assistant", content: [toolUseBlock(tid, toolName, { command: "ls", path: "/tmp" })] })
    msgs.push({ role: "user", content: [toolResultBlock(tid, "X".repeat(contentLen), isErrorOld)] })
    for (let e = 0; e < extraUserPerRound; e++) msgs.push({ role: "user", content: `extra text ${i}-${e}` })
  }
  for (let i = 0; i < recentRounds; i++) {
    const tid = `${idPrefix}_new${i}`
    msgs.push({ role: "assistant", content: [toolUseBlock(tid, toolName, { command: "ls", path: "/tmp" })] })
    msgs.push({ role: "user", content: [toolResultBlock(tid, "Y".repeat(contentLen), isErrorRecent)] })
    for (let e = 0; e < extraUserPerRound; e++) msgs.push({ role: "user", content: `extra text recent ${i}-${e}` })
  }
  return msgs
}

// ── K26: historical 轮次按 assistant 计数 ───────────────────────────────────

describe("K26 — historical round cut by assistant count", () => {
  test("compacts oldest rounds, preserves the last keepRecentRounds rounds despite many user messages", () => {
    const msgs = buildHistoricalMessages({
      oldRounds: 12,
      recentRounds: 8,
      toolName: "shell",
      contentLen: 6000,
      idPrefix: "toolu",
      extraUserPerRound: 2,
    })
    const assistantCount = msgs.filter(m => m.role === "assistant").length
    const userCount = msgs.filter(m => m.role === "user").length
    expect(assistantCount).toBe(20)
    // 旧公式 messages.length - 8*2 ≈ 65 > 20 → 永不压缩；新公式以 20 为基数。
    expect(userCount).toBeGreaterThan(assistantCount * 3)

    const compacted = pl.compactHistoricalToolResults(msgs, 8)
    expect(compacted).toBe(12)

    // 最早 12 轮被压缩
    for (let i = 0; i < 12; i++) {
      const c = findToolResult(msgs, `toolu_old${i}`)
      expect(c).toContain("[Microcompact: historical")
      expect(c).not.toBe("X".repeat(6000))
    }
    // 最近 8 轮保留完整
    for (let i = 0; i < 8; i++) {
      expect(findToolResult(msgs, `toolu_new${i}`)).toBe("Y".repeat(6000))
    }
  })

  test("when keepRecentRounds covers all rounds, nothing is compacted", () => {
    const msgs = buildHistoricalMessages({ oldRounds: 3, recentRounds: 3, toolName: "shell", contentLen: 6000, idPrefix: "toolu" })
    expect(pl.compactHistoricalToolResults(msgs, 8)).toBe(0)
    expect(findToolResult(msgs, "toolu_old0")).toBe("X".repeat(6000))
  })
})

// ── K27: historical 工具类型从相邻 tool_use 块解析 ───────────────────────────

describe("K27 — historical tool type resolved from adjacent tool_use", () => {
  test("toolu_/call_ ids for read_file/shell/web_fetch are recognized and compacted; write_file is not", () => {
    const msgs: ProviderMessage[] = [
      { role: "user", content: "task" },
      // read_file 用 provider 风格 id toolu_…：必须经 tool_use 映射识别（阈值 2000 可压缩）
      { role: "assistant", content: [toolUseBlock("toolu_read_1", "read_file", { path: "/a" })] },
      { role: "user", content: [toolResultBlock("toolu_read_1", "R".repeat(4000))] },
      { role: "assistant", content: [toolUseBlock("call_shell_2", "shell", { command: "make" })] },
      { role: "user", content: [toolResultBlock("call_shell_2", "S".repeat(6000))] },
      { role: "assistant", content: [toolUseBlock("toolu_fetch_3", "web_fetch", { url: "http://x" })] },
      { role: "user", content: [toolResultBlock("toolu_fetch_3", "W".repeat(8000))] },
      // write_file 不属于 read_file/shell/web_fetch → 不压缩
      { role: "assistant", content: [toolUseBlock("toolu_write_4", "write_file", { path: "/b" })] },
      { role: "user", content: [toolResultBlock("toolu_write_4", "V".repeat(8000))] },
    ]
    const compacted = plReadfile.compactHistoricalToolResults(msgs, 0)
    expect(compacted).toBe(3)
    expect(findToolResult(msgs, "toolu_read_1")).toContain("[Microcompact: historical")
    expect(findToolResult(msgs, "call_shell_2")).toContain("[Microcompact: historical")
    expect(findToolResult(msgs, "toolu_fetch_3")).toContain("[Microcompact: historical")
    expect(findToolResult(msgs, "toolu_write_4")).toBe("V".repeat(8000))
  })
})

// ── K28: read_file 阈值 0 → 前向/历史都不压缩 ────────────────────────────────

describe("K28 — read_file threshold 0 → never compacts (uniform forward/historical)", () => {
  test("forward path does not compact read_file when threshold is 0", () => {
    expect(pl.mcThreshold("read_file")).toBe(0)
    const { results, compacted } = pl.microcompactToolResults(
      [{ type: "tool_result", tool_use_id: "r1", content: "R".repeat(5000), is_error: false }],
      [{ id: "r1", name: "read_file", input: { path: "/big" } }],
    )
    expect(compacted).toBe(0)
    expect(String(results[0]!.content)).toBe("R".repeat(5000))
  })

  test("historical path does not compact read_file when threshold is 0", () => {
    const msgs: ProviderMessage[] = [
      { role: "user", content: "task" },
      { role: "assistant", content: [toolUseBlock("toolu_r", "read_file", { path: "/big" })] },
      { role: "user", content: [toolResultBlock("toolu_r", "R".repeat(5000))] },
    ]
    expect(pl.compactHistoricalToolResults(msgs, 0)).toBe(0)
    expect(findToolResult(msgs, "toolu_r")).toBe("R".repeat(5000))
  })

  test("shell (threshold 3000) still compacts in forward path for contrast", () => {
    const { results, compacted } = pl.microcompactToolResults(
      [{ type: "tool_result", tool_use_id: "s1", content: "S".repeat(5000), is_error: false }],
      [{ id: "s1", name: "shell", input: { command: "make" } }],
    )
    expect(compacted).toBe(1)
    expect(String(results[0]!.content)).toContain("[Microcompact:")
  })
})

// ── K25: 失败 Pin（is_error 永不压缩）────────────────────────────────────────

describe("K25 — failed results are pinned (never compacted)", () => {
  test("forward path pins is_error results in full", () => {
    const { results, compacted } = pl.microcompactToolResults(
      [{ type: "tool_result", tool_use_id: "e1", content: "E".repeat(9000), is_error: true }],
      [{ id: "e1", name: "shell", input: { command: "make" } }],
    )
    expect(compacted).toBe(0)
    expect(String(results[0]!.content)).toBe("E".repeat(9000))
    expect(String(results[0]!.content)).not.toContain("[Microcompact:")
  })

  test("historical path pins is_error results, still compacts success results in old rounds", () => {
    const msgs: ProviderMessage[] = [
      { role: "user", content: "task" },
      // 失败轮：is_error → Pin，不压缩
      { role: "assistant", content: [toolUseBlock("toolu_err", "shell", { command: "make" })] },
      { role: "user", content: [toolResultBlock("toolu_err", "E".repeat(9000), true)] },
      // 成功轮：可压缩
      { role: "assistant", content: [toolUseBlock("toolu_ok", "shell", { command: "make" })] },
      { role: "user", content: [toolResultBlock("toolu_ok", "O".repeat(9000), false)] },
    ]
    const compacted = pl.compactHistoricalToolResults(msgs, 0)
    expect(compacted).toBe(1)
    expect(findToolResult(msgs, "toolu_err")).toBe("E".repeat(9000))
    expect(findToolResult(msgs, "toolu_ok")).toContain("[Microcompact: historical")
  })
})

// ── K5: persist 钩子（前向压缩前持久化完整内容）───────────────────────────────

describe("K5 — persist hook for forward microcompact", () => {
  test("persist is called with full content before truncation and placeholder gains [Artifact: ref]", () => {
    const persisted: Array<{ content: string; toolName: string; toolUseId: string }> = []
    const content = "A".repeat(5000)
    const { results, compacted } = pl.microcompactToolResults(
      [{ type: "tool_result", tool_use_id: "t1", content, is_error: false }],
      [{ id: "t1", name: "shell", input: { command: "pytest" } }],
      (c, meta) => {
        persisted.push({ content: c, toolName: meta.toolName, toolUseId: meta.toolUseId })
        return `ref-${meta.toolUseId}`
      },
    )
    expect(compacted).toBe(1)
    expect(persisted).toHaveLength(1)
    expect(persisted[0]!.content).toBe(content)
    expect(persisted[0]!.toolName).toBe("shell")
    expect(persisted[0]!.toolUseId).toBe("t1")
    const out = String(results[0]!.content)
    expect(out).toContain("[Artifact: ref-t1]")
    expect(out).toContain("[Microcompact: shell")
    expect(out).not.toContain("A".repeat(5000))
  })

  test("persist returning null compacts without an artifact reference", () => {
    const { results, compacted } = pl.microcompactToolResults(
      [{ type: "tool_result", tool_use_id: "t2", content: "B".repeat(5000), is_error: false }],
      [{ id: "t2", name: "shell", input: { command: "make" } }],
      () => null,
    )
    expect(compacted).toBe(1)
    const out = String(results[0]!.content)
    expect(out).toContain("[Microcompact:")
    expect(out).not.toContain("[Artifact:")
  })

  test("without persist hook behaviour is identical to baseline (no [Artifact:])", () => {
    const { results, compacted } = pl.microcompactToolResults(
      [{ type: "tool_result", tool_use_id: "t3", content: "C".repeat(5000), is_error: false }],
      [{ id: "t3", name: "shell", input: { command: "make" } }],
    )
    expect(compacted).toBe(1)
    const out = String(results[0]!.content)
    expect(out).toContain("[Microcompact: shell")
    expect(out).not.toContain("[Artifact:")
    // 与基线一致：head 300 + 占位符
    expect(out.startsWith("C".repeat(300))).toBe(true)
  })
})
