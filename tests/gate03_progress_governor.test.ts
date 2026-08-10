/**
 * GATE-03 v2（GS-P1~P6）— ProgressGovernor 行为测试。
 *
 * v1 → v2 兼容策略：单元 helper 从 snapshot() 重写为 roundProgressInput()，
 * 行为断言语义等价保留：
 *   (a) 空输入四连轨迹 proceed → proceed → ACTION_FIRST → REPLAN_ONCE → STALLED
 *   (b) 真实进展信号（写类提交/文件集增长/节点/证据）清零 streak
 *   (c) pendingObligationDigest 变化不算进展（模型换说辞 ≠ 推进）
 *   (d) 提示文本断言
 *   (e) TruncatedEmptyProvider 端到端：5 次 provider round 内 STALLED（GS-01）
 */

import { describe, expect, test } from "bun:test"
import { ProgressGovernor, actionFirstPrompt, replanOncePrompt, type RoundProgressInput } from "../src/agent/kernel/progress-governor"
import { AgentState, StateMachine } from "../src/agent/state-machine"
import { agentLoop } from "../src/agent/loop"
import type { AgentRunTrace } from "../src/agent/run-trace"
import { HookEvent, HookSystem } from "../src/hooks"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../src/provider/types"
import { buildTools, Result } from "../src/tools/registry"
import type { RoundToolCall } from "../src/agent/run/types"

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
  }
}

const writeTool = (name = "write_file"): RoundToolCall => ({ id: "t-w1", name, input: { path: "a.ts" } })
const readTool = (path: string, id = "t-r1"): RoundToolCall => ({ id, name: "read_file", input: { path } })

class MemoryTrace {
  events: Array<{ type: string; data?: unknown }> = []
  record(type: string, data?: unknown) {
    this.events.push({ type, data })
  }
}

function probeTool() {
  return buildTools({
    name: "baseline_probe",
    description: "Return a deterministic read-only probe result",
    isReadonly: true,
    isConcurrencySafe: true,
    inputSchema: { type: "object", properties: {}, required: [] },
    execute() {
      return Result.ok("probe-ok")
    },
  })
}

describe("ProgressGovernor 状态机（GS-P2）", () => {
  test("连续 4 轮无进展：记录 → ACTION_FIRST → REPLAN_ONCE → STALLED", () => {
    const governor = new ProgressGovernor()
    const s = roundInput()
    // 首轮无基准 → proceed（记录）
    expect(governor.evaluate(s).action).toBe("proceed")
    // 连续 1 轮 → 记录（proceed，trace 由调用方做）
    expect(governor.evaluate(s).action).toBe("proceed")
    expect(governor.consecutiveNoProgress).toBe(1)
    // 连续 2 轮 → ACTION_FIRST
    expect(governor.evaluate(s).action).toBe("action_first")
    // 连续 3 轮 → REPLAN_ONCE
    expect(governor.evaluate(s).action).toBe("replan_once")
    // 连续 4 轮 → STALLED + 诊断（GS-P6 字段）
    const stalled = governor.evaluate(s)
    expect(stalled.action).toBe("stalled")
    if (stalled.action === "stalled") {
      expect(stalled.reason).toBe("streak")
      expect(stalled.report).toContain("运行停滞")
      expect(stalled.report).toContain("GS-P2")
      expect(stalled.report).toContain("近 4 轮 Delta 明细")
      expect(stalled.report).toContain("[execution=0, evidence=0, epistemic=0, control=0]")
    }
  })

  test("任何真实进展信号变化都清零 streak", () => {
    const governor = new ProgressGovernor()
    governor.evaluate(roundInput())
    governor.evaluate(roundInput()) // streak=1
    expect(governor.consecutiveNoProgress).toBe(1)
    // 写类工具提交 → execution 进展
    expect(governor.evaluate(roundInput({ committedToolCalls: [writeTool()] })).action).toBe("proceed")
    expect(governor.consecutiveNoProgress).toBe(0)
    // 文件集增长 → execution 进展
    governor.evaluate(roundInput({ fileCount: 3 }))
    expect(governor.consecutiveNoProgress).toBe(0)
    // 计划节点推进 → control 进展
    governor.evaluate(roundInput({ completedNodes: 1 }))
    expect(governor.consecutiveNoProgress).toBe(0)
    // 证据条目增长 → evidence 进展
    governor.evaluate(roundInput({ evidenceEntries: 1 }))
    expect(governor.consecutiveNoProgress).toBe(0)
  })

  test("pendingObligationDigest 变化不算进展（模型换说辞 ≠ 推进）", () => {
    const governor = new ProgressGovernor()
    governor.evaluate(roundInput())
    governor.evaluate(roundInput())
    // 只有 digest 变 → 仍无进展
    expect(governor.evaluate(roundInput({ pendingObligationDigest: "steps:c|d" })).action).toBe("action_first")
    expect(governor.consecutiveNoProgress).toBe(2)
  })

  test("ACTION_FIRST/REPLAN_ONCE 提示要求动作、不重复（GS-02 语义）", () => {
    const af = actionFirstPrompt().content as string
    expect(af).toContain("禁止只输出文本")
    expect(af).toContain("工具调用")
    const rp = replanOncePrompt().content as string
    expect(rp).toContain("仅此一次")
    expect(rp).toContain("不要重复")
  })

  test("TB2-1: RECON→FINALIZE 无真实通过证据 → 不算 control 进展", () => {
    const governor = new ProgressGovernor()
    // 首轮 RECON 基准。
    governor.evaluate(roundInput({ round: 1 }))
    // DONE 状态（无任何验证证据）→ 阶段切到 FINALIZE 但不算 control 进展。
    const bare = governor.evaluate(roundInput({ round: 2, agentState: AgentState.DONE }))
    expect(governor.consecutiveNoProgress).toBe(1)
    expect(bare.delta?.effective).toBe(false)
    // 有真实通过证据的 FINALIZE 才算进展（阶段转换 + evidence）。
    governor.evaluate(roundInput({
      round: 3,
      agentState: AgentState.DONE,
      verificationResults: [{ kind: "test", command: "bun test", passed: true } as never],
    }))
    expect(governor.consecutiveNoProgress).toBe(0)
  })
})

describe("状态机 STALLED 终态", () => {
  test("任意执行状态可转 STALLED", () => {
    const sm = new StateMachine()
    sm.transition(AgentState.UNDERSTAND, "start")
    sm.transition(AgentState.SEARCH, "search")
    sm.transition(AgentState.CODE, "code")
    sm.transition(AgentState.STALLED, "连续 4 轮无进展")
    expect(sm.currentState).toBe(AgentState.STALLED)
    // STALLED 是终态：无出口转换
    expect(() => sm.transition(AgentState.REPAIR, "must not")).toThrow()
  })

  test("DONE 可转 STALLED（ProgressGovernor 终止优先于完成终态，EVAL-006 实证）", () => {
    const sm = new StateMachine()
    sm.transition(AgentState.UNDERSTAND, "start")
    sm.transition(AgentState.SEARCH, "search")
    sm.transition(AgentState.CODE, "code")
    sm.transition(AgentState.DONE, "task complete")
    expect(sm.currentState).toBe(AgentState.DONE)
    // 写码后 4 轮无进展 → ProgressGovernor STALLED 必须可落地（不再 fatal）
    sm.transition(AgentState.STALLED, "GS-P2 连续 4 轮无有效进展")
    expect(sm.currentState).toBe(AgentState.STALLED)
  })
})

describe("kernel 级：截断空轮 4 连 → STALLED 终止（GS-01 承接 GS-P2）", () => {
  test("provider 每轮只有截断无产出 → stopReason=stalled，不无限循环", async () => {
    const SAVED_ORCANA_FLASH_TRIAGE = process.env.ORCANA_FLASH_TRIAGE
    process.env.ORCANA_FLASH_TRIAGE = "off"

    class TruncatedEmptyProvider implements LLMProvider {
      rounds = 0
      async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
        this.rounds++
        // 每轮都被截断且无任何产出 —— OTS-013 的"无工具空转"形状
        yield { type: "truncated", data: { stopReason: "max_tokens", toolCalls: 0 } }
      }
    }

    const trace = new MemoryTrace()
    const stopReasons: string[] = []
    const hooks = new HookSystem()
    hooks.on(HookEvent.Stop, input => {
      stopReasons.push(input.reason)
      return {}
    })
    const events: StreamEvent[] = []
    for await (const event of agentLoop("inspect the project state", {
      provider: new TruncatedEmptyProvider(),
      model: "test",
      tools: probeTool(),
      hooks,
      runTrace: trace as unknown as AgentRunTrace,
      contextMapPolicy: "off",
      maxRounds: 20,
    })) {
      events.push(event)
    }

    if (SAVED_ORCANA_FLASH_TRIAGE === undefined) delete process.env.ORCANA_FLASH_TRIAGE
    else process.env.ORCANA_FLASH_TRIAGE = SAVED_ORCANA_FLASH_TRIAGE

    // GS-P2：连续 4 轮无进展必须终止 STALLED（而非无限重试）
    expect(stopReasons).toEqual(["stalled"])
    const stalledEvents = events.filter(e => e.type === "status" && String(e.data).includes("STALLED"))
    expect(stalledEvents.length).toBeGreaterThanOrEqual(1)
    const diag = events.find(e => e.type === "error" && String(e.data).includes("运行停滞"))
    expect(diag).toBeDefined()
    // 4 轮无进展 + 首轮基准 = 5 次 provider round 内必须终止
    const stalledRoundTrace = trace.events.find(e => e.type === "agent_loop_stalled")
    expect(stalledRoundTrace).toBeDefined()
    // 每轮 progress_delta trace（GS-P6）必须存在
    const deltas = trace.events.filter(e => e.type === "progress_delta")
    expect(deltas.length).toBeGreaterThanOrEqual(5)
  })
})

// ── v2 语义：新观察 read 在 RECON 阶段是 epistemic 进展（误杀修复） ──

describe("v2：novel read 在 RECON 是进展（OTS-013 误杀修复）", () => {
  test("连续读不同新文件 → streak 不增长（epistemic 续命）", () => {
    const governor = new ProgressGovernor()
    governor.evaluate(roundInput())
    governor.evaluate(roundInput({ committedToolCalls: [readTool("a.ts")] }))
    expect(governor.consecutiveNoProgress).toBe(0)
    governor.evaluate(roundInput({ committedToolCalls: [readTool("b.ts", "t-r2")] }))
    expect(governor.consecutiveNoProgress).toBe(0)
    governor.evaluate(roundInput({ committedToolCalls: [readTool("c.ts", "t-r3")] }))
    expect(governor.consecutiveNoProgress).toBe(0)
  })

  test("同文件重读（同输出）→ 不算进展，streak 照常增长", () => {
    const governor = new ProgressGovernor()
    governor.evaluate(roundInput())
    const input = roundInput({ committedToolCalls: [readTool("a.ts")], toolResults: [{ type: "tool_result", tool_use_id: "t-r1", content: "same" }] })
    governor.evaluate(input)
    expect(governor.consecutiveNoProgress).toBe(0)
    // 重读同文件同输出 → 无 novel
    governor.evaluate(roundInput({ round: 3, committedToolCalls: [readTool("a.ts")], toolResults: [{ type: "tool_result", tool_use_id: "t-r1", content: "same" }] }))
    expect(governor.consecutiveNoProgress).toBe(1)
    // 同文件新输出 → novel（观察到新事实）
    governor.evaluate(roundInput({ round: 4, committedToolCalls: [readTool("a.ts")], toolResults: [{ type: "tool_result", tool_use_id: "t-r1", content: "different" }] }))
    expect(governor.consecutiveNoProgress).toBe(0)
  })
})
