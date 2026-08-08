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

// ── GS-P4：Action Commitment（Owner 定稿语义） ──

describe("GS-P4 — Action Commitment", () => {
  test("承诺 → 2 轮无同类工具 → ACTION_REQUIRED → 再 1 轮 → stalled(commitment)", () => {
    const g = new ProgressGovernor()
    // round 1：模型承诺"把失败清单落盘"（无工具调用）→ debt=1
    g.evaluate(input({ finalText: "我接下来把失败清单落盘保存。" }))
    // round 2：read（异类，novel）→ 不偿付，debt=2
    g.evaluate(read("a.ts", "r1"))
    // round 3：read 重复 → debt=3 → ACTION_REQUIRED
    const ar = g.evaluate(read("a.ts", "r2"))
    expect(ar.action).toBe("action_required")
    if (ar.action === "action_required") {
      expect(ar.commitment.actionClass).toBe("write")
    }
    // round 4：仍无同类工具 → stalled（reason=commitment，先于 streak 4 轮）
    const stalled = g.evaluate(read("a.ts", "r3"))
    expect(stalled.action).toBe("stalled")
    if (stalled.action === "stalled") {
      expect(stalled.reason).toBe("commitment")
      expect(stalled.report).toContain("GS-P4")
      expect(stalled.report).toContain("未执行承诺")
    }
  })

  test("同类工具偿付 → 清除（真实 dispatch 即算，成功与否无关）", () => {
    const g = new ProgressGovernor()
    g.evaluate(input({ finalText: "现在写入修复代码。" }))
    // write_file dispatch（结果 is_error 也不影响偿付）
    const d = g.evaluate(input({
      committedToolCalls: [{ id: "w", name: "write_file", input: { path: "a.ts" } }],
      toolResults: [{ type: "tool_result", tool_use_id: "w", content: "FAILED", is_error: true }],
    }))
    expect(d.delta?.commitment).toBeNull()
    expect(d.delta?.effective).toBe(true) // 写类 dispatch = execution
  })

  test("异类不偿付：承诺 write 后只读 → debt 增长到 ACTION_REQUIRED", () => {
    const g = new ProgressGovernor()
    g.evaluate(input({ finalText: "我接下来写入修复代码。" })) // 注册轮，debt=0
    g.evaluate(read("a.ts", "r1")) // 异类不偿付 → debt=1
    // read（异类，novel）→ 不偿付，debt=2 → ACTION_REQUIRED（无条件，§7）
    const d = g.evaluate(read("b.ts", "r2"))
    expect(d.action).toBe("action_required")
    // 后续 novel read 有进展 → 不 stalled（§8 需要无其他 EffectiveProgress）
    const d2 = g.evaluate(read("c.ts", "r3"))
    expect(d2.action).not.toBe("stalled")
  })

  test("显式目标跑偏不偿付：承诺 deepseek.ts 写 docs/notes.md → 债务+1", () => {
    const g = new ProgressGovernor()
    g.evaluate(input({ finalText: "下一步修改 src/provider/deepseek.ts 的失败路径。" }))
    // 同是 write 类但目标无关（token 交集空）→ 不偿付
    const d = g.evaluate(input({ committedToolCalls: [{ id: "w", name: "write_file", input: { path: "docs/notes.md" } }] }))
    expect(d.delta?.commitment).not.toBeNull()
    // 目标兼容：写 deepseek 相关文件 → 偿付
    const ok = g.evaluate(input({ committedToolCalls: [{ id: "w2", name: "write_file", input: { path: "src/provider/deepseek.test.ts" } }] }))
    expect(ok.delta?.commitment).toBeNull()
  })

  test("新文本承诺不重置 debt 时钟（防每 2 轮再承诺一次）", () => {
    const g = new ProgressGovernor()
    g.evaluate(input({ finalText: "我接下来写入 A。" })) // 注册轮 debt=0
    g.evaluate(read("a.ts", "r1")) // 不偿付 → debt=1
    // 新承诺替换 active，债务续计（debt 仍 1，未清零）
    g.evaluate(input({ finalText: "我接下来写入 B。" }))
    expect(g.pendingCommitmentDebt).toBe(1)
    // 若新承诺重置了债务，下一轮只是 ok；续计时 → debt=2 → ACTION_REQUIRED
    const d = g.evaluate(read("b.ts", "r2"))
    expect(d.action).toBe("action_required")
  })

  test("P4 STALLED 需要无其他 EffectiveProgress（有进展时只 action_required 不 stalled）", () => {
    const g = new ProgressGovernor()
    g.evaluate(input({ finalText: "我接下来写入修复。" }))
    g.evaluate(input({ completedSteps: 1 })) // 有 control 进展但未偿付
    g.evaluate(input({ completedSteps: 2 })) // 仍有进展
    const d = g.evaluate(input({ completedSteps: 3 }))
    // debt 已超 cap 但每轮都有 EffectiveProgress → 不 stalled（GS-P4 §8）
    expect(d.action).not.toBe("stalled")
  })

  test("commitmentPrompt 要求同类工具调用", () => {
    const { commitmentPrompt } = require("../src/agent/kernel/progress-governor") as typeof import("../src/agent/kernel/progress-governor")
    const content = commitmentPrompt().content as string
    expect(content).toContain("同类")
    expect(content).toContain("工具调用")
  })
})
