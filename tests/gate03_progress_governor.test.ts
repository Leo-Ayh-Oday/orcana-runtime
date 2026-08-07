/**
 * GATE-03 — ProgressGovernor（GS-01/GS-02）
 *
 * OTS-013 死循环的正式断环点：run-scoped liveness 控制器。
 *   连续 1 轮无进展 → NO_PROGRESS（记录）
 *   连续 2 轮 → ACTION_FIRST（思考降级、必须发出工具调用）
 *   连续 3 轮 → REPLAN_ONCE（不得重复注入相同提示）
 *   连续 4 轮 → STALLED（终止 + 完整诊断）
 * "模型多写了 4000 token 不算进展"——只有状态变化才算。
 */

import { describe, expect, test } from "bun:test"
import { ProgressGovernor, actionFirstPrompt, replanOncePrompt, type ProgressSnapshot } from "../src/agent/kernel/progress-governor"
import { AgentState, StateMachine } from "../src/agent/state-machine"
import { agentLoop } from "../src/agent/loop"
import type { AgentRunTrace } from "../src/agent/run-trace"
import { HookEvent, HookSystem } from "../src/hooks"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../src/provider/types"
import { buildTools, Result } from "../src/tools/registry"

function snapshot(overrides: Partial<ProgressSnapshot> = {}): ProgressSnapshot {
  return {
    round: 1,
    toolCallsCommitted: 0,
    writeToolsCommitted: 0,
    fileCount: 0,
    completedNodes: 0,
    completedSteps: 0,
    evidenceEntries: 0,
    currentNode: "1",
    pendingObligationDigest: "steps:a|b",
    ...overrides,
  }
}

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

describe("ProgressGovernor 状态机（GS-01）", () => {
  test("连续 4 轮无进展：记录 → ACTION_FIRST → REPLAN_ONCE → STALLED", () => {
    const governor = new ProgressGovernor()
    const s = snapshot()
    // 首轮无基准 → proceed（记录）
    expect(governor.evaluate(s).action).toBe("proceed")
    // 连续 1 轮 → 记录（proceed，trace 由调用方做）
    expect(governor.evaluate(s).action).toBe("proceed")
    expect(governor.consecutiveNoProgress).toBe(1)
    // 连续 2 轮 → ACTION_FIRST
    expect(governor.evaluate(s).action).toBe("action_first")
    // 连续 3 轮 → REPLAN_ONCE
    expect(governor.evaluate(s).action).toBe("replan_once")
    // 连续 4 轮 → STALLED + 诊断
    const stalled = governor.evaluate(s)
    expect(stalled.action).toBe("stalled")
    if (stalled.action === "stalled") {
      expect(stalled.report).toContain("运行停滞")
      expect(stalled.report).toContain("4 轮")
    }
  })

  test("任何真实进展信号变化都清零 streak", () => {
    const governor = new ProgressGovernor()
    governor.evaluate(snapshot())
    governor.evaluate(snapshot()) // streak=1
    expect(governor.consecutiveNoProgress).toBe(1)
    // 工具调用提交 → 进展
    expect(governor.evaluate(snapshot({ toolCallsCommitted: 2 })).action).toBe("proceed")
    expect(governor.consecutiveNoProgress).toBe(0)
    // 文件集增长 → 进展
    governor.evaluate(snapshot({ fileCount: 3 }))
    expect(governor.consecutiveNoProgress).toBe(0)
    // 计划节点推进 → 进展
    governor.evaluate(snapshot({ completedNodes: 1 }))
    expect(governor.consecutiveNoProgress).toBe(0)
    // 证据条目增长 → 进展
    governor.evaluate(snapshot({ evidenceEntries: 1 }))
    expect(governor.consecutiveNoProgress).toBe(0)
  })

  test("pendingObligationDigest 变化不算进展（模型换说辞 ≠ 推进）", () => {
    const governor = new ProgressGovernor()
    governor.evaluate(snapshot())
    governor.evaluate(snapshot())
    // 只有 digest 变 → 仍无进展
    expect(governor.evaluate(snapshot({ pendingObligationDigest: "steps:c|d" })).action).toBe("action_first")
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
})

describe("kernel 级：截断空轮 4 连 → STALLED 终止（GS-01 端到端）", () => {
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

    // GS-01：连续 4 轮无进展必须终止 STALLED（而非无限重试）
    expect(stopReasons).toEqual(["stalled"])
    const stalledEvents = events.filter(e => e.type === "status" && String(e.data).includes("STALLED"))
    expect(stalledEvents.length).toBeGreaterThanOrEqual(1)
    const diag = events.find(e => e.type === "error" && String(e.data).includes("运行停滞"))
    expect(diag).toBeDefined()
    // 4 轮无进展 + 首轮基准 = 5 次 provider round 内必须终止
    const stalledRoundTrace = trace.events.find(e => e.type === "agent_loop_stalled")
    expect(stalledRoundTrace).toBeDefined()
  })
})
