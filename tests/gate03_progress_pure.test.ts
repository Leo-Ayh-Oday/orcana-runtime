/**
 * GS-P 纯函数单测 —— fingerprint / commitment / phase 三模块。
 * （阶段 1 地基：不接线，确定性可测）
 */

import { describe, expect, test } from "bun:test"
import { AgentState } from "../src/agent/state-machine"
import {
  FingerprintLedger,
  ReconBudget,
  canonicalInput,
  stableDigest,
  outputTextOf,
} from "../src/agent/kernel/progress-fingerprint"
import {
  CommitmentRegistry,
  detectCommitment,
  targetCompatible,
  toolActionClass,
  type ActionCommitment,
} from "../src/agent/kernel/progress-commitment"
import { derivePhase, PHASE_RULES, type ProgressPhase } from "../src/agent/kernel/progress-phase"
import type { RoundToolCall } from "../src/agent/run/types"

// ── fingerprint：确定性 ──

describe("指纹确定性（GS-P5）", () => {
  test("stableDigest：同输入同摘要，序无关", () => {
    expect(stableDigest(["a", "b"])).toBe(stableDigest(["a", "b"]))
    expect(stableDigest(["a", "b"])).not.toBe(stableDigest(["b", "a"]))
    expect(stableDigest(["a", "b"]).length).toBe(16)
  })

  test("canonicalInput：对象键序不影响指纹", () => {
    expect(canonicalInput({ a: 1, b: 2 })).toBe(canonicalInput({ b: 2, a: 1 }))
    expect(canonicalInput(null)).toBe("")
    expect(canonicalInput("str")).toBe(JSON.stringify("str"))
  })

  test("outputTextOf：content/output 提取与缺失退化", () => {
    expect(outputTextOf({ type: "tool_result", content: "abc" })).toBe("abc")
    expect(outputTextOf({ output: "xyz" })).toBe("xyz")
    expect(outputTextOf(undefined)).toBe("")
    expect(outputTextOf({ content: 42 })).toBe("42")
  })
})

// ── FingerprintLedger：新颖性 ──

describe("FingerprintLedger（GS-P5）", () => {
  test("read 类：同文件同输出重读 → 非 novel；新文件 → novel", () => {
    const ledger = new FingerprintLedger()
    expect(ledger.noteRead("read_file", { path: "a.ts" }, { content: "text1" })).toBe(true)
    expect(ledger.noteRead("read_file", { path: "a.ts" }, { content: "text1" })).toBe(false)
    expect(ledger.noteRead("read_file", { path: "b.ts" }, { content: "text2" })).toBe(true)
  })

  test("read 类：同文件新输出 → novel（观察到了新事实）", () => {
    const ledger = new FingerprintLedger()
    expect(ledger.noteRead("read_file", { path: "a.ts" }, { content: "v1" })).toBe(true)
    expect(ledger.noteRead("read_file", { path: "a.ts" }, { content: "v2" })).toBe(true)
  })

  test("command 类：同命令同输出完全重复；同命令新输出 = 新输出增量", () => {
    const ledger = new FingerprintLedger()
    const first = ledger.noteCommand("terminal", { cmd: "bun test" }, { content: "FAIL 1" })
    expect(first).toEqual({ cmdNovel: true, outNovel: true })
    const repeat = ledger.noteCommand("terminal", { cmd: "bun test" }, { content: "FAIL 1" })
    expect(repeat).toEqual({ cmdNovel: false, outNovel: false })
    const newOut = ledger.noteCommand("terminal", { cmd: "bun test" }, { content: "FAIL 2" })
    expect(newOut).toEqual({ cmdNovel: false, outNovel: true })
  })

  test("verification 类：同结果重复 → 非 novel；FAIL↔PASS 翻转 → verdictChanged", () => {
    const ledger = new FingerprintLedger()
    const first = ledger.noteVerification("test", "bun test", false)
    expect(first.resultNovel).toBe(true)
    expect(first.verdictChanged).toBe(false)
    const repeat = ledger.noteVerification("test", "bun test", false)
    expect(repeat.resultNovel).toBe(false)
    expect(repeat.verdictChanged).toBe(false)
    const flipped = ledger.noteVerification("test", "bun test", true)
    expect(flipped.resultNovel).toBe(true)
    expect(flipped.verdictChanged).toBe(true)
  })

  test("cap 淘汰：超限后最旧指纹被遗忘（方向=放宽，安全）", () => {
    const ledger = new FingerprintLedger(8)
    for (let i = 1; i <= 8; i++) expect(ledger.note(`f${i}`)).toBe(true)
    expect(ledger.note("f9")).toBe(true) // 淘汰最旧 25% = 2 个（f1, f2）
    expect(ledger.note("f1")).toBe(true) // f1 已遗忘 → 再次 novel（放宽方向）
    expect(ledger.note("f3")).toBe(false) // f3 仍在
  })

  test("重复观察计数（报告用）", () => {
    const ledger = new FingerprintLedger()
    ledger.noteRead("read_file", { path: "a.ts" }, { content: "x" })
    ledger.noteRead("read_file", { path: "a.ts" }, { content: "x" })
    ledger.noteRead("read_file", { path: "a.ts" }, { content: "x" })
    ledger.noteRepeat()
    expect(ledger.repeatCount).toBe(1)
  })
})

// ── ReconBudget（GS-P5） ──

describe("ReconBudget（GS-P5）", () => {
  test("预算上限：超限后 trySpend=false", () => {
    const budget = new ReconBudget(3)
    expect(budget.trySpend()).toBe(true)
    expect(budget.trySpend()).toBe(true)
    expect(budget.trySpend()).toBe(true)
    expect(budget.exhausted).toBe(true)
    expect(budget.trySpend()).toBe(false)
  })

  test("阶段切换 reset（由 governor 调用）", () => {
    const budget = new ReconBudget(3)
    budget.trySpend()
    budget.trySpend()
    budget.reset()
    expect(budget.used).toBe(0)
    expect(budget.trySpend()).toBe(true)
  })
})

// ── phase 映射（GS-P3） ──

describe("derivePhase（GS-P3）", () => {
  test("状态 → 阶段映射", () => {
    expect(derivePhase(AgentState.SEARCH, { failedThisRound: false, passedThisRound: false })).toBe("RECON")
    expect(derivePhase(AgentState.UNDERSTAND, { failedThisRound: false, passedThisRound: false })).toBe("RECON")
    expect(derivePhase(AgentState.PLAN, { failedThisRound: false, passedThisRound: false })).toBe("PLAN")
    expect(derivePhase(AgentState.CODE, { failedThisRound: false, passedThisRound: false })).toBe("IMPLEMENT")
    expect(derivePhase(AgentState.REPAIR, { failedThisRound: true, passedThisRound: false })).toBe("RECOVER")
    expect(derivePhase(AgentState.DONE, { failedThisRound: false, passedThisRound: false })).toBe("FINALIZE")
  })

  test("VERIFY + failed → DIAGNOSE；VERIFY 无 failed → VERIFY", () => {
    expect(derivePhase(AgentState.VERIFY, { failedThisRound: true, passedThisRound: false })).toBe("DIAGNOSE")
    expect(derivePhase(AgentState.VERIFY, { failedThisRound: false, passedThisRound: true })).toBe("VERIFY")
  })

  test("PHASE_RULES：IMPLEMENT 不认 epistemic/evidence；RECON 全认；FINALIZE 只认 evidence+control", () => {
    expect(PHASE_RULES.IMPLEMENT).toEqual({ execution: true, evidence: false, epistemic: false, control: true })
    expect(PHASE_RULES.RECON.epistemic).toBe(true)
    expect(PHASE_RULES.FINALIZE.execution).toBe(false)
    expect(PHASE_RULES.FINALIZE.evidence).toBe(true)
    expect(PHASE_RULES.PLAN.epistemic).toBe(false)
    // 七阶段齐全
    const phases: ProgressPhase[] = ["RECON", "DIAGNOSE", "PLAN", "IMPLEMENT", "VERIFY", "FINALIZE", "RECOVER"]
    for (const p of phases) expect(PHASE_RULES[p]).toBeDefined()
  })
})

// ── 承诺检测（GS-P4 正则） ──

describe("detectCommitment（GS-P4）", () => {
  test("中文正例：把失败清单落盘 → write", () => {
    const c = detectCommitment("先把失败清单落盘保存，然后继续。", 3)
    expect(c).not.toBeNull()
    expect(c!.actionClass).toBe("write")
    expect(c!.createdRound).toBe(3)
    expect(c!.text).toContain("落盘")
  })

  test("中文正例：重跑测试确认 → verify；修改文件带显式目标 → write+target", () => {
    const v = detectCommitment("我接下来重跑测试确认一下。", 4)
    expect(v?.actionClass).toBe("verify")
    const w = detectCommitment("下一步修改 src/provider/deepseek.ts 的失败路径。", 5)
    expect(w?.actionClass).toBe("write")
    expect(w?.target?.kind).toBe("file")
    expect(w?.target?.value).toBe("src/provider/deepseek.ts")
  })

  test("英文正例：i'll run the tests → verify；will fix → write", () => {
    const a = detectCommitment("I'll run the tests to confirm.", 6)
    expect(a?.actionClass).toBe("verify")
    const b = detectCommitment("Next I will fix the failing test.", 7)
    expect(b?.actionClass).toBe("write")
  })

  test("反例锁定：继续分析/总结/阐述不构成承诺", () => {
    expect(detectCommitment("我需要继续分析这个问题。", 1)).toBeNull()
    expect(detectCommitment("总结一下上面的方案。", 1)).toBeNull()
    expect(detectCommitment("以上思路已阐述完毕。", 1)).toBeNull()
    expect(detectCommitment("", 1)).toBeNull()
  })

  test("无动作动词的文本不命中", () => {
    expect(detectCommitment("这个任务很复杂，需要谨慎处理。", 1)).toBeNull()
  })
})

// ── 工具 → 动作类 + 目标兼容 ──

describe("toolActionClass / targetCompatible（GS-P4 偿付）", () => {
  const tc = (name: string, input: Record<string, unknown>): RoundToolCall => ({
    id: "t1", name, input,
  })

  test("工具名 → 类", () => {
    expect(toolActionClass("read_file", "")).toBe("inspect")
    expect(toolActionClass("write_file", "")).toBe("write")
    expect(toolActionClass("edit_file", "")).toBe("write")
    expect(toolActionClass("webfetch", "")).toBe("external")
    expect(toolActionClass("terminal", "")).toBe("execute")
    expect(toolActionClass("terminal", "bun test tests/x")).toBe("verify")
    expect(toolActionClass("run_command", "npx tsc --noEmit")).toBe("verify")
    expect(toolActionClass("unknown_tool", "")).toBe("execute")
  })

  test("显式目标兼容：同路径 token 交集 → 兼容；无关目标 → 不兼容", () => {
    const target = { kind: "file" as const, value: "src/provider/deepseek.ts" }
    expect(targetCompatible(target, tc("write_file", { path: "src/provider/deepseek.ts" }))).toBe(true)
    expect(targetCompatible(target, tc("write_file", { path: "src/provider/deepseek.test.ts" }))).toBe(true)
    expect(targetCompatible(target, tc("write_file", { path: "docs/notes.md" }))).toBe(false)
  })

  test("无显式目标 → 恒兼容（IF_EXPLICIT）", () => {
    expect(targetCompatible(undefined, tc("write_file", { path: "anywhere" }))).toBe(true)
    expect(targetCompatible({ kind: "workspace", value: undefined }, tc("write_file", { path: "anywhere" }))).toBe(true)
  })
})

// ── CommitmentRegistry：债务计时 ──

describe("CommitmentRegistry（GS-P4）", () => {
  const tc = (name: string): RoundToolCall => ({ id: "t", name, input: {} })
  const commit = (cls: ActionCommitment["actionClass"], text: string): ActionCommitment => ({
    actionClass: cls, createdRound: 1, fingerprint: `c:${cls}`, text,
  })

  test("无承诺 → 恒 ok", () => {
    const reg = new CommitmentRegistry(2)
    expect(reg.tickRound([tc("read_file")]).status).toBe("ok")
  })

  test("承诺 write + 连续 2 轮无同类工具 → action_required → 再 1 轮 stalled", () => {
    const reg = new CommitmentRegistry(2)
    reg.register(commit("write", "把失败清单落盘"))
    expect(reg.tickRound([tc("read_file")]).status).toBe("ok") // 异类不偿付，debt=1
    expect(reg.tickRound([tc("read_file")]).status).toBe("action_required") // debt=2
    expect(reg.tickRound([tc("read_file")]).status).toBe("stalled") // debt=3
  })

  test("同类工具偿付 → 清除（成功与否无关，真实 dispatch 即算）", () => {
    const reg = new CommitmentRegistry(2)
    reg.register(commit("write", "把失败清单落盘"))
    const r = reg.tickRound([tc("write_file")])
    expect(r.discharged).toBe(true)
    expect(reg.active).toBeNull()
  })

  test("异类工具不偿付：承诺 write 读文件 → debt+1", () => {
    const reg = new CommitmentRegistry(2)
    reg.register(commit("write", "写代码"))
    expect(reg.tickRound([tc("read_file")]).discharged).toBe(false)
    expect(reg.pendingDebt).toBe(1)
  })

  test("承诺 verify + 执行验证命令 → 偿付", () => {
    const reg = new CommitmentRegistry(2)
    reg.register(commit("verify", "重跑测试"))
    const r = reg.tickRound([{ id: "t", name: "terminal", input: { cmd: "bun test" } }])
    expect(r.discharged).toBe(true)
  })

  test("新承诺不重置 debt 时钟（防每 2 轮再承诺一次的 Goodhart）", () => {
    const reg = new CommitmentRegistry(2)
    reg.register(commit("write", "写 A"))
    reg.tickRound([tc("read_file")]) // debt=1
    reg.register(commit("write", "写 B")) // 新承诺替换 active，债务续计
    expect(reg.pendingDebt).toBe(1)
    expect(reg.tickRound([tc("read_file")]).status).toBe("action_required") // debt 1→2
    expect(reg.tickRound([tc("read_file")]).status).toBe("stalled") // debt 3
  })

  test("审计队列 ≤3", () => {
    const reg = new CommitmentRegistry(2)
    reg.register(commit("write", "c1"))
    reg.tickRound([tc("write_file")])
    reg.register(commit("write", "c2"))
    reg.tickRound([tc("write_file")])
    reg.register(commit("write", "c3"))
    reg.tickRound([tc("write_file")])
    reg.register(commit("write", "c4"))
    reg.tickRound([tc("write_file")])
    expect(reg.recentAudit.length).toBeLessThanOrEqual(3)
  })
})
