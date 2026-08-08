/**
 * GS-P1~P6 Progress Contract 合同测试（v2）。
 * P1 ontology / P2 窗口 / P3 阶段 / P5 预算（P4 在阶段 3，评测场景在阶段 4）。
 */

import { describe, expect, test } from "bun:test"
import { ProgressGovernor, type RoundProgressInput, type ProgressConfig } from "../src/agent/kernel/progress-governor"
import { AgentState } from "../src/agent/state-machine"
import type { RoundToolCall } from "../src/agent/run/types"
import type { VerificationResult } from "../src/verification/result"

function input(overrides: Partial<RoundProgressInput> = {}): RoundProgressInput {
  return {
    round: 1,
    agentState: AgentState.SEARCH,
    finalText: "",
    committedToolCalls: [],
    toolResults: [],
    verificationResults: [],
    fileCount: 0,
    completedNodes: 0,
    completedSteps: 0,
    currentNode: "1",
    evidenceEntries: 0,
    pendingObligationDigest: "steps:a|b",
    ...overrides,
  }
}

const read = (path: string, id: string, content = "content"): RoundProgressInput => ({
  ...input(),
  committedToolCalls: [{ id, name: "read_file", input: { path } }],
  toolResults: [{ type: "tool_result", tool_use_id: id, content }],
})
const cmd = (cmdText: string, id: string, output = "out"): RoundProgressInput => ({
  ...input(),
  committedToolCalls: [{ id, name: "terminal", input: { cmd: cmdText } }],
  toolResults: [{ type: "tool_result", tool_use_id: id, content: output }],
})
const verify = (kind: VerificationResult["kind"], command: string, passed: boolean): VerificationResult => ({
  kind, command, passed, issues: passed ? 0 : 3, durationMs: 10, summary: "",
})

// ── GS-P1：EffectiveProgress Ontology ──

describe("GS-P1 — 四维 Delta 各自触发 effective", () => {
  test("execution：写类工具提交 → effective", () => {
    const g = new ProgressGovernor()
    const d = g.evaluate(input({ committedToolCalls: [{ id: "w", name: "write_file", input: { path: "a.ts" } }] }))
    expect(d.action).toBe("proceed")
    expect(d.delta?.execution).toBeGreaterThan(0)
    expect(d.delta?.effective).toBe(true)
    expect(d.delta?.reasons).toContain("写类 write_file")
  })

  test("evidence：新验证结果 → effective", () => {
    const g = new ProgressGovernor()
    const d = g.evaluate(input({ verificationResults: [verify("test", "bun test", false)] }))
    expect(d.delta?.evidence).toBeGreaterThan(0)
    expect(d.delta?.effective).toBe(true)
  })

  test("epistemic：新文件阅读（预算内）→ effective", () => {
    const g = new ProgressGovernor()
    const d = g.evaluate(read("docs/a.md", "r1"))
    expect(d.delta?.epistemic).toBe(1)
    expect(d.delta?.effective).toBe(true)
  })

  test("control：步骤推进 → effective", () => {
    const g = new ProgressGovernor()
    g.evaluate(input())
    const d = g.evaluate(input({ completedSteps: 1 }))
    expect(d.delta?.control).toBeGreaterThan(0)
    expect(d.delta?.effective).toBe(true)
  })

  test("阶段转换 → control 进展", () => {
    const g = new ProgressGovernor()
    g.evaluate(input()) // RECON 基准
    const d = g.evaluate(input({ agentState: AgentState.CODE }))
    expect(d.delta?.phase).toBe("IMPLEMENT")
    expect(d.delta?.control).toBeGreaterThan(0)
  })
})

describe("GS-P1 — 负面清单（均不构成 progress）", () => {
  test("纯文本：无工具无状态变化 → 无 delta", () => {
    const g = new ProgressGovernor()
    g.evaluate(input({ finalText: "让我想想" }))
    const d = g.evaluate(input({ finalText: "我打算这样" }))
    expect(d.delta?.effective).toBe(false)
    expect(g.consecutiveNoProgress).toBe(1)
  })

  test("重复观察：同文件同输出重读 → 无 delta", () => {
    const g = new ProgressGovernor()
    g.evaluate(read("a.ts", "r1"))
    const d = g.evaluate(read("a.ts", "r1"))
    expect(d.delta?.effective).toBe(false)
  })

  test("同结果重复验证 → 无 delta", () => {
    const g = new ProgressGovernor()
    g.evaluate(input({ verificationResults: [verify("test", "bun test", false)] }))
    const d = g.evaluate(input({ verificationResults: [verify("test", "bun test", false)] }))
    expect(d.delta?.effective).toBe(false)
    expect(d.delta?.reasons).toContain("重复验证 test:false")
  })

  test("同命令同输出重复 → 无 delta（v1 的 count 相等场景）", () => {
    const g = new ProgressGovernor()
    g.evaluate(cmd("bun test", "c1", "FAIL 1"))
    const d = g.evaluate(cmd("bun test", "c1", "FAIL 1"))
    expect(d.delta?.effective).toBe(false)
    expect(d.delta?.reasons).toContain("重复命令 terminal")
  })

  test("同命令新输出 → 探索增量（execution）", () => {
    const g = new ProgressGovernor()
    g.evaluate(cmd("bun test", "c1", "FAIL 1"))
    const d = g.evaluate(cmd("bun test", "c1", "FAIL 2"))
    expect(d.delta?.effective).toBe(true)
    expect(d.delta?.execution).toBeGreaterThan(0)
  })
})

// ── GS-P3：阶段感知 ──

describe("GS-P3 — 阶段感知评分", () => {
  test("RECON：novel read 计数（epistemic）", () => {
    const g = new ProgressGovernor()
    const d = g.evaluate(read("a.md", "r1"))
    expect(d.delta?.phase).toBe("RECON")
    expect(d.delta?.epistemic).toBe(1)
  })

  test("IMPLEMENT：同 read 不计数、write 计数（只认 execution + control）", () => {
    const g = new ProgressGovernor()
    g.evaluate(input()) // RECON 基准
    g.evaluate(input({ agentState: AgentState.CODE })) // 阶段转换 → IMPLEMENT（control+1，生效）
    // IMPLEMENT 中 novel read → epistemic 被掩码 → 不 effective
    const readD = g.evaluate(input({ agentState: AgentState.CODE, committedToolCalls: [{ id: "r", name: "read_file", input: { path: "new.md" } }], toolResults: [{ type: "tool_result", tool_use_id: "r", content: "x" }] }))
    expect(readD.delta?.phase).toBe("IMPLEMENT")
    expect(readD.delta?.epistemic).toBe(0)
    expect(readD.delta?.effective).toBe(false)
    // IMPLEMENT 中 write → execution 计数
    const writeD = g.evaluate(input({ agentState: AgentState.CODE, committedToolCalls: [{ id: "w", name: "edit_file", input: { path: "a.ts" } }] }))
    expect(writeD.delta?.execution).toBeGreaterThan(0)
    expect(writeD.delta?.effective).toBe(true)
  })

  test("DIAGNOSE：VERIFY+failed → 认 FAIL→PASS 翻转（evidence+2）", () => {
    const g = new ProgressGovernor()
    g.evaluate(input({ agentState: AgentState.VERIFY, verificationResults: [verify("test", "bun test", false)] }))
    expect(g.consecutiveNoProgress).toBe(0)
    const flip = g.evaluate(input({ agentState: AgentState.VERIFY, verificationResults: [verify("test", "bun test", true)] }))
    expect(flip.delta?.phase).toBe("VERIFY")
    // failed→passed：本轮无 failed → VERIFY 阶段；翻转 evidence+2
    expect(flip.delta?.evidence).toBe(2)
    expect(flip.delta?.effective).toBe(true)
    expect(flip.delta?.reasons).toContain("验证翻转 test:true")
  })

  test("VERIFY + failed 本轮 → DIAGNOSE 阶段", () => {
    const g = new ProgressGovernor()
    const d = g.evaluate(input({ agentState: AgentState.VERIFY, verificationResults: [verify("test", "bun test", false)] }))
    expect(d.delta?.phase).toBe("DIAGNOSE")
  })

  test("PLAN：计划文本重写不算进展（epistemic/evidence 掩码）", () => {
    const g = new ProgressGovernor()
    g.evaluate(input({ agentState: AgentState.PLAN }))
    const d = g.evaluate(input({ agentState: AgentState.PLAN, finalText: "计划变了" }))
    expect(d.delta?.phase).toBe("PLAN")
    expect(d.delta?.effective).toBe(false)
  })
})

// ── GS-P5：Recon 预算 ──

describe("GS-P5 — Reconnaissance Budget", () => {
  test("第 21 个 novel read 不再产生 epistemic（默认预算 20）", () => {
    const g = new ProgressGovernor()
    g.evaluate(input()) // 基准
    for (let i = 1; i <= 20; i++) {
      g.evaluate(read(`f${i}.md`, `r${i}`))
    }
    // 预算已耗尽
    const d21 = g.evaluate(read("f21.md", "r21"))
    expect(d21.delta?.novelty.exhausted).toBe(true)
    expect(d21.delta?.epistemic).toBe(0)
    expect(d21.delta?.effective).toBe(false)
  })

  test("阶段切换重置预算", () => {
    const cfg: ProgressConfig = { stallRounds: 4, reconBudget: 3, commitmentDebt: 2, seenCap: 1024 }
    const g = new ProgressGovernor(cfg)
    g.evaluate(read("a.md", "r1"))
    g.evaluate(read("b.md", "r2"))
    g.evaluate(read("c.md", "r3"))
    expect(g.evaluate(read("d.md", "r4")).delta?.epistemic).toBe(0) // 耗尽
    // 阶段切换（SEARCH → CODE）→ 预算重置
    g.evaluate(input({ agentState: AgentState.CODE }))
    const after = g.evaluate(read("e.md", "r5"))
    expect(after.delta?.epistemic).toBe(1) // 重置后恢复计数
  })

  test("重复观察不消耗预算（novel 才 trySpend）", () => {
    const cfg: ProgressConfig = { stallRounds: 4, reconBudget: 2, commitmentDebt: 2, seenCap: 1024 }
    const g = new ProgressGovernor(cfg)
    g.evaluate(read("a.md", "r1"))
    g.evaluate(read("a.md", "r1")) // 重复 → 不花费
    g.evaluate(read("b.md", "r2"))
    expect(g.evaluate(read("c.md", "r3")).delta?.epistemic).toBe(0) // 2/2 已用
  })
})

// ── GS-P2：窗口固定（配置 4 不变） ──

describe("GS-P2 — 窗口固定 4 轮", () => {
  test("stallRounds 可配置但默认 4（窗口不放宽）", () => {
    expect(ProgressGovernor.prototype).toBeDefined()
    const g = new ProgressGovernor()
    for (let i = 0; i < 4; i++) g.evaluate(input())
    const d = g.evaluate(input())
    expect(d.action).toBe("stalled")
  })
})
