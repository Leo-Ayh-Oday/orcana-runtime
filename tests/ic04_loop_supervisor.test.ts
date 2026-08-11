/** IC04: LoopSupervisor —— Loop Liveness Authority 测试矩阵（§51）。
 *
 *  L1  no-progress ladder（2/3/4 → ACTION_FIRST/REPLAN_ONCE/STALLED，语义保留）
 *  L2  novel recon 不误杀（noProgressStreak = 0）
 *  L3  duplicate recon 进 ladder
 *  L4  truncation ladder（#1 lower_thinking / #2 action_first / #3 stalled）
 *  L5  partial tool truncation 同三阶、executed = 0
 *  L6  truncated_after_action 不进入 truncation recovery（streak reset）
 *  L7  progress 重置 truncation streak
 *  L8  round budget（maxRounds = 2 → exact 2 轮、terminal round_budget）
 */

import { describe, expect, test } from "bun:test"
import { LoopSupervisor, LIVENESS_THINKING_CAP_TOKENS, type LoopSupervisorDecision } from "../src/agent/kernel/loop-supervisor"
import { ProgressGovernor, type RoundProgressInput } from "../src/agent/kernel/progress-governor"
import { AgentState } from "../src/agent/state-machine"
import type { ProviderFinishReason } from "../src/provider/types"

function roundInput(overrides: Partial<RoundProgressInput> = {}): RoundProgressInput {
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
  } as RoundProgressInput
}

function supervisor() {
  return new LoopSupervisor(new ProgressGovernor())
}

/** 连续 n 轮 truncation（P0-1: 每轮必须带 progressInput —— 无进展输入）。 */
function truncationRounds(s: LoopSupervisor, n: number, reason: ProviderFinishReason = "truncated_before_action"): LoopSupervisorDecision[] {
  const decisions: LoopSupervisorDecision[] = []
  for (let i = 0; i < n; i++) {
    decisions.push(s.afterRound({
      round: i,
      finishReason: reason,
      executableToolCallCount: 0,
      sideEffectBoundaryCrossed: false,
      progressInput: roundInput({ round: i }),
    }))
  }
  return decisions
}

describe("IC04 L1: no-progress ladder（语义保留）", () => {
  test("baseline → 连续 4 轮无进展 → ACTION_FIRST/REPLAN_ONCE/STALLED", () => {
    const s = supervisor()
    // 首轮是基准轮（streak 不计）；之后每轮无进展 streak+1：
    // streak 2 → ACTION_FIRST，3 → REPLAN_ONCE，4 → STALLED（语义保留）。
    expect(s.afterRound({ round: 0, finishReason: "complete", executableToolCallCount: 0, sideEffectBoundaryCrossed: false, progressInput: roundInput({ round: 0 }) }).action).toBe("proceed")
    const r1 = s.afterRound({ round: 1, finishReason: "complete", executableToolCallCount: 0, sideEffectBoundaryCrossed: false, progressInput: roundInput({ round: 1, finalText: "思考中" }) })
    expect(r1.action).toBe("proceed")
    expect(s.consecutiveNoProgress).toBe(1)
    const r2 = s.afterRound({ round: 2, finishReason: "complete", executableToolCallCount: 0, sideEffectBoundaryCrossed: false, progressInput: roundInput({ round: 2 }) })
    expect(r2.action).toBe("action_first")
    expect(r2.nextRoundPolicy.recoveryMode).toBe("action_first")
    const r3 = s.afterRound({ round: 3, finishReason: "complete", executableToolCallCount: 0, sideEffectBoundaryCrossed: false, progressInput: roundInput({ round: 3 }) })
    expect(r3.action).toBe("replan_once")
    const r4 = s.afterRound({ round: 4, finishReason: "complete", executableToolCallCount: 0, sideEffectBoundaryCrossed: false, progressInput: roundInput({ round: 4 }) })
    expect(r4.action).toBe("stalled")
    if (r4.action === "stalled") expect(r4.reason).toBe("progress")
  })
})

describe("IC04 L2: novel recon 不误杀", () => {
  test("read a / b / c 均 novel → noProgressStreak = 0", () => {
    const s = supervisor()
    const toolResults: Array<Record<string, unknown>> = []
    let i = 0
    for (const path of ["a.ts", "b.ts", "c.ts"]) {
      const tc = { id: `t-${i++}`, name: "read_file", input: { path } }
      toolResults.push({ type: "tool_result", tool_use_id: tc.id, content: `content-${path}` })
      const d = s.afterRound({
        round: i,
        finishReason: "tool_action",
        executableToolCallCount: 1,
        sideEffectBoundaryCrossed: true,
        progressInput: roundInput({ round: i, committedToolCalls: [tc], toolResults }),
      })
      expect(d.action).toBe("proceed")
      expect(s.consecutiveNoProgress).toBe(0)
    }
  })
})

describe("IC04 L3: duplicate recon 进 ladder", () => {
  test("read a 同输出 4 次 → 进 no-progress ladder", () => {
    const s = supervisor()
    const tc = { id: "t-r1", name: "read_file", input: { path: "a.ts" } }
    const toolResults: Array<Record<string, unknown>> = [{ type: "tool_result", tool_use_id: "t-r1", content: "same-output" }]
    s.afterRound({ round: 0, finishReason: "tool_action", executableToolCallCount: 1, sideEffectBoundaryCrossed: true, progressInput: roundInput({ round: 0, committedToolCalls: [tc], toolResults }) })
    const decisions = []
    for (let i = 1; i <= 4; i++) {
      decisions.push(s.afterRound({ round: i, finishReason: "tool_action", executableToolCallCount: 1, sideEffectBoundaryCrossed: true, progressInput: roundInput({ round: i, committedToolCalls: [tc], toolResults }) }).action)
    }
    // 首轮基准后：3 个无进展轮 → 第 3 轮 REPLAN…（streak: 1,2,3 → action_first, replan, stalled+1）
    expect(decisions[2]).toBe("replan_once")
    expect(decisions[3]).toBe("stalled")
  })
})

describe("IC04 L4: truncation ladder", () => {
  test("连续 3 次 truncated_before_action → lower_thinking / action_first / stalled(truncation)", () => {
    const s = supervisor()
    const [d1, d2, d3] = truncationRounds(s, 3)
    expect(d1!.action).toBe("lower_thinking")
    expect(d1!.nextRoundPolicy.recoveryMode).toBe("lower_thinking")
    expect(d1!.nextRoundPolicy.thinkingCapTokens).toBe(LIVENESS_THINKING_CAP_TOKENS)
    expect(d2!.action).toBe("action_first")
    expect(d2!.nextRoundPolicy.recoveryMode).toBe("action_first")
    expect(d3!.action).toBe("stalled")
    if (d3!.action === "stalled") expect(d3!.reason).toBe("truncation")
  })

  test("第 4 次同类 truncation 不得发生（物理轮次 ≤ 3）", () => {
    const s = supervisor()
    truncationRounds(s, 3)
    // 第 4 次调用也会返回 stalled —— 但 loop 层在 #3 就 break；
    // 这里证明 streak 有界。
    const d4 = s.afterRound({ round: 4, finishReason: "truncated_before_action", executableToolCallCount: 0, sideEffectBoundaryCrossed: false, progressInput: roundInput({ round: 4 }) })
    expect(d4.action).toBe("stalled")
    if (d4.action === "stalled") expect(d4.reason).toBe("truncation")
  })
})

describe("IC04 L5: partial tool truncation 同三阶", () => {
  test("连续 truncated_partial_tool + executable=0 → 同 ladder，executed tools = 0", () => {
    const s = supervisor()
    const [d1, d2, d3] = truncationRounds(s, 3, "truncated_partial_tool")
    expect(d1!.action).toBe("lower_thinking")
    expect(d2!.action).toBe("action_first")
    expect(d3!.action).toBe("stalled")
    if (d3!.action === "stalled") expect(d3!.reason).toBe("truncation")
  })

  test("truncated_partial_tool + executable > 0 → 不进入 ladder（有真实副作用）", () => {
    const s = supervisor()
    const d = s.afterRound({ round: 0, finishReason: "truncated_partial_tool", executableToolCallCount: 1, sideEffectBoundaryCrossed: true, progressInput: roundInput({ round: 0, committedToolCalls: [{ id: "t-r1", name: "read_file", input: { path: "a.ts" } }] }) })
    expect(d.action).toBe("proceed")
    expect(s.truncationStreak).toBe(0)
  })
})

describe("IC04 L6: truncated_after_action 不进入 truncation recovery", () => {
  test("Tool A complete + truncated_after_action → streak = 0", () => {
    const s = supervisor()
    s.afterRound({ round: 0, finishReason: "truncated_after_action", executableToolCallCount: 1, sideEffectBoundaryCrossed: true, progressInput: roundInput({ round: 0, committedToolCalls: [{ id: "t-1", name: "read_file", input: { path: "a.ts" } }] }) })
    expect(s.truncationStreak).toBe(0)
    const d = s.afterRound({ round: 1, finishReason: "truncated_before_action", executableToolCallCount: 0, sideEffectBoundaryCrossed: false, progressInput: roundInput({ round: 1 }) })
    // truncated_after_action 已 reset —— 下一次 truncation 重新从 #1 计。
    expect(d.action).toBe("lower_thinking")
    expect(s.truncationStreak).toBe(1)
  })
})

describe("IC04 L7: progress 重置 truncation streak", () => {
  test("truncated_before_action → lower_thinking；下轮有效进展 → streak=0；再截断重新 #1", () => {
    const s = supervisor()
    truncationRounds(s, 1)
    expect(s.truncationStreak).toBe(1)
    // 有效进展轮（写类工具）→ effective → reset
    const tc = { id: "t-w1", name: "write_file", input: { path: "a.ts" } }
    s.afterRound({
      round: 10,
      finishReason: "tool_action",
      executableToolCallCount: 1,
      sideEffectBoundaryCrossed: true,
      progressInput: roundInput({ round: 10, committedToolCalls: [tc], toolResults: [{ type: "tool_result", tool_use_id: "t-w1", content: "ok" }], fileCount: 1 }),
    })
    expect(s.truncationStreak).toBe(0)
    // 下一次 truncation 重新视为 #1
    const d = s.afterRound({ round: 11, finishReason: "truncated_before_action", executableToolCallCount: 0, sideEffectBoundaryCrossed: false, progressInput: roundInput({ round: 11, fileCount: 1 }) })
    expect(d.action).toBe("lower_thinking")
    expect(s.truncationStreak).toBe(1)
  })
})

describe("IC04 L8: round budget", () => {
  test("maxRounds=2 → beforeRound: START,START,ROUND_BUDGET（无 off-by-one）", () => {
    const s = supervisor()
    expect(s.beforeRound(0, 2)).toBe("START")
    expect(s.beforeRound(1, 2)).toBe("START")
    expect(s.beforeRound(2, 2)).toBe("ROUND_BUDGET")
  })

  test("PROGRESS_EVALUATION_PER_ROUND_MAX = 1：同 round 重复评价 fail closed", () => {
    const s = supervisor()
    const obs = { round: 0, finishReason: "complete" as const, executableToolCallCount: 0, sideEffectBoundaryCrossed: false, progressInput: roundInput({ round: 0 }) }
    expect(s.afterRound(obs).action).toBe("proceed")
    expect(() => s.afterRound(obs)).toThrow(/double progress evaluation/)
  })
})

describe("IC04 precedence（§16）", () => {
  test("truncation streak=2 优先于 governor action_first", () => {
    const s = supervisor()
    // governor streak 也到 2（action_first 决策轮）
    truncationRounds(s, 1)
    const d = s.afterRound({ round: 1, finishReason: "truncated_before_action", executableToolCallCount: 0, sideEffectBoundaryCrossed: false, progressInput: roundInput({ round: 1 }) })
    // #2 truncation → ACTION_FIRST（truncation 优先）
    expect(d.action).toBe("action_first")
    expect(d.nextRoundPolicy.recoveryMode).toBe("action_first")
  })

  test("truncation streak=3 优先于 governor stalled", () => {
    const s = supervisor()
    truncationRounds(s, 2)
    const d = s.afterRound({ round: 2, finishReason: "truncated_before_action", executableToolCallCount: 0, sideEffectBoundaryCrossed: false, progressInput: roundInput({ round: 2 }) })
    expect(d.action).toBe("stalled")
    if (d.action === "stalled") expect(d.reason).toBe("truncation")
  })
})

describe("IC04 P0-1: early-continue 必须 progress accounting", () => {
  test("连续 continue 轮（无 EffectiveProgress）→ streak 增长 → ACTION_FIRST/REPLAN/STALLED，不得静默绕过 ladder", () => {
    const s = supervisor()
    // 模拟 provider-recovery / orchestrator continue：每轮只带文本、无工具产出。
    // P0-1 前这些路径不 evaluate —— streak 恒 0，ladder 永不触发。
    s.afterRound({ round: 0, finishReason: "complete", executableToolCallCount: 0, sideEffectBoundaryCrossed: false, progressInput: roundInput({ round: 0 }) })
    const d1 = s.afterRound({ round: 1, finishReason: "complete", executableToolCallCount: 0, sideEffectBoundaryCrossed: false, progressInput: roundInput({ round: 1, finalText: "思考中" }) })
    expect(d1.action).toBe("proceed")
    expect(s.consecutiveNoProgress).toBe(1)
    const d2 = s.afterRound({ round: 2, finishReason: "complete", executableToolCallCount: 0, sideEffectBoundaryCrossed: false, progressInput: roundInput({ round: 2 }) })
    expect(d2.action).toBe("action_first")
    const d3 = s.afterRound({ round: 3, finishReason: "complete", executableToolCallCount: 0, sideEffectBoundaryCrossed: false, progressInput: roundInput({ round: 3 }) })
    expect(d3.action).toBe("replan_once")
    const d4 = s.afterRound({ round: 4, finishReason: "complete", executableToolCallCount: 0, sideEffectBoundaryCrossed: false, progressInput: roundInput({ round: 4 }) })
    expect(d4.action).toBe("stalled")
  })

  test("progressInput 缺失在类型层即拒绝（contract required）", () => {
    // 编译期保证：LoopSupervisorObservation.progressInput 必选。
    // 运行时 double-evaluation 仍 fail closed（§10，见 L8）。
    const s = supervisor()
    s.afterRound({ round: 0, finishReason: "complete", executableToolCallCount: 0, sideEffectBoundaryCrossed: false, progressInput: roundInput({ round: 0 }) })
    expect(() => s.afterRound({ round: 0, finishReason: "complete", executableToolCallCount: 0, sideEffectBoundaryCrossed: false, progressInput: roundInput({ round: 0 }) })).toThrow(/double progress evaluation/)
  })
})

describe("IC04 P1-11: effective progress 优先 reset truncation streak", () => {
  test("truncation streak=1 后：truncated_before_action + effective=true → streak=0，不进 #2 ACTION_FIRST", () => {
    const s = supervisor()
    truncationRounds(s, 1)
    expect(s.truncationStreak).toBe(1)
    // 本轮 finishReason 属于 no-action truncation class，但 progressInput
    // 产出 effective（写类提交 + 文件集增长）—— reset 必须优先。
    const tc = { id: "t-w1", name: "write_file", input: { path: "a.ts" } }
    const d = s.afterRound({
      round: 10,
      finishReason: "truncated_before_action",
      executableToolCallCount: 0,
      sideEffectBoundaryCrossed: false,
      progressInput: roundInput({
        round: 10,
        committedToolCalls: [tc],
        toolResults: [{ type: "tool_result", tool_use_id: "t-w1", content: "ok" }],
        fileCount: 1,
      }),
    })
    expect(s.truncationStreak).toBe(0)
    expect(d.action).toBe("proceed")
  })
})
