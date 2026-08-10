/** TB2-1 回归：轮次耗尽 ≠ 完成、强制 checkpoint、CLI 退出码、Resume 校验。
 *
 * 覆盖：
 *  - maxRounds=4 首轮读文件后连续空截断 → paused 非 completed，changedFiles 为空
 *  - 低上下文占用暂停也必须产生 checkpoint（不依赖自适应阈值）+ decision.checkpointId
 *  - Provider 空截断轮不得触发 revise-plan（只有真正执行计划步骤但失败才允许）
 *  - CLI 单次模式未交付时退出码非零（0 完成 / 2 暂停 / 3 阻塞 / 4 失败）
 *  - Resume 校验：步骤数/当前步骤/修改文件自洽，失败 → RESUME_REJECTED
 */

import { afterAll, describe, expect, test } from "bun:test"
import { agentLoop } from "../src/agent/loop"
import { createAgentHarness } from "../src/harness/runtime/agent-harness"
import { SessionStore } from "../src/session/sqlite-session"
import { loadCheckpoint, registerCheckpointStore, unregisterCheckpointStore } from "../src/session/checkpoint"
import { buildTools, Result } from "../src/tools/registry"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../src/provider/types"
import type { LoopDecision } from "../src/agent/kernel/types"
import { HookEvent, HookSystem } from "../src/hooks"
import { classifyRunStatus, exitCodeForRunStatus, validateResumeCheckpoint } from "../src/ui/run-outcome"
import type { SessionCheckpoint } from "../src/session/checkpoint"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SAVED_ORCANA_FLASH_TRIAGE = process.env.ORCANA_FLASH_TRIAGE
process.env.ORCANA_FLASH_TRIAGE = "off"
afterAll(() => {
  if (SAVED_ORCANA_FLASH_TRIAGE === undefined) delete process.env.ORCANA_FLASH_TRIAGE
  else process.env.ORCANA_FLASH_TRIAGE = SAVED_ORCANA_FLASH_TRIAGE
})

class MemoryTrace {
  events: Array<{ type: string; data?: unknown }> = []
  record(type: string, data?: unknown) {
    this.events.push({ type, data })
  }
}

/** 首轮只读 decomp.c，之后每轮空截断（无工具无文本）——TB2-1 故障组合。 */
class ReadThenTruncateProvider implements LLMProvider {
  rounds = 0
  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    if (this.rounds++ === 0) {
      yield { type: "tool_call", data: { id: "read-1", name: "read_file", input: { path: "decomp.c" } } }
      return
    }
    yield { type: "truncated", data: { stopReason: "max_tokens", toolCalls: 0 } }
  }
}

/** 每轮都请求工具——自然耗尽轮次预算。 */
class AlwaysToolProvider implements LLMProvider {
  rounds = 0
  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.rounds++
    yield { type: "tool_call", data: { id: `probe-${this.rounds}`, name: "baseline_probe", input: {} } }
  }
}

function readFileTool() {
  return buildTools({
    name: "read_file",
    description: "Read a file (deterministic test stub)",
    isReadonly: true,
    isConcurrencySafe: true,
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    execute(input: { path?: unknown }) {
      return Result.ok(`contents of ${String(input?.path ?? "?")}`)
    },
  })
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

/** 收集事件并捕获 agentLoop 的返回值（LoopDecision）。 */
async function collectWithDecision(
  iterable: AsyncIterable<StreamEvent>,
): Promise<{ events: StreamEvent[]; decision: LoopDecision }> {
  const events: StreamEvent[] = []
  const iterator = iterable[Symbol.asyncIterator]()
  while (true) {
    const step = await iterator.next()
    if (step.done) return { events, decision: step.value }
    events.push(step.value)
  }
}

describe("TB2-1: 轮次耗尽 = budget_exhausted ≠ 完成", () => {
  test("maxRounds=4 首轮读文件后连续空截断 → paused，不得认作 DONE/成功", async () => {
    const trace = new MemoryTrace()
    const stopReasons: string[] = []
    const hooks = new HookSystem()
    hooks.on(HookEvent.Stop, input => {
      stopReasons.push(input.reason)
      return {}
    })
    const { decision, events } = await collectWithDecision(agentLoop("inspect the project state", {
      provider: new ReadThenTruncateProvider(),
      model: "test",
      tools: readFileTool(),
      hooks,
      runTrace: trace as never,
      contextMapPolicy: "off",
      maxRounds: 4,
    }))

    expect(decision).toMatchObject({ kind: "break", reason: "round_budget" })
    // 不是 DONE：Stop 钩子拿到的必须是 paused，不是 completed。
    expect(stopReasons).toEqual(["paused"])
    // 没有 STALLED（截断轮在轮次上限内结束）、没有 "task complete" 类终态。
    expect(trace.events.find(e => e.type === "agent_loop_stalled")).toBeUndefined()
    expect(events.some(e => e.type === "status" && String(e.data).includes("task complete"))).toBe(false)

    // TB2-1: 只读 decomp.c 不产生 changedFiles —— agent_loop_finished 必须为空。
    const finished = trace.events.find(e => e.type === "agent_loop_finished")
    expect(finished).toBeDefined()
    expect((finished!.data as { changedFiles: string[] }).changedFiles).toEqual([])
  })

  test("低上下文占用暂停 → 强制保存 checkpoint（不依赖上下文阈值）且 decision 携带 checkpointId", async () => {
    const sessionId = "sess-tb21-forced-cp"
    const storeDir = mkdtempSync(join(tmpdir(), "orcana-tb21-cp-"))
    const store = new SessionStore(sessionId, storeDir)
    registerCheckpointStore(sessionId, store)
    try {
      const { decision } = await collectWithDecision(agentLoop("inspect the project state", {
        provider: new AlwaysToolProvider(),
        model: "test",
        tools: probeTool(),
        contextMapPolicy: "off",
        maxRounds: 3,
        sessionId,
      }))
      expect(decision).toMatchObject({ kind: "break", reason: "round_budget" })
      // 上下文占用为 0（远低于 20% 自适应阈值）也必须产生 checkpoint。
      const checkpointId = (decision as { checkpointId?: string }).checkpointId ?? ""
      expect(checkpointId).toBeTruthy()
      const cp = loadCheckpoint(sessionId)
      expect(cp).not.toBeNull()
      expect(cp!.checkpointId).toBe(checkpointId)
      expect(cp!.round).toBe(2) // finalRound = maxRounds - 1
      expect(cp!.sessionId).toBe(sessionId)
    } finally {
      unregisterCheckpointStore(sessionId)
      store.close()
    }
  })

  test("轮次耗尽 + 暂停事件 → CLI 单次模式退出码 2（INCOMPLETE）", async () => {
    const harness = createAgentHarness({
      deps: { provider: new AlwaysToolProvider(), tools: probeTool() },
      sessionId: "sess-tb21-exit",
    })
    const session = await harness.createSession()
    const events = []
    for await (const event of harness.run(session.sessionId, { prompt: "inspect the project state", maxRounds: 2 } as never)) {
      events.push(event)
    }
    const paused = events.find(e => e.type === "run.paused") as { payload: { status: string; checkpointId?: string } } | undefined
    expect(paused).toBeDefined()
    expect(paused!.payload.checkpointId).toBeTruthy()
    const status = classifyRunStatus(paused!.payload.status as never)
    expect(status).toBe("paused")
    expect(exitCodeForRunStatus(status)).toBe(2)
    const snapshot = await harness.inspect(events[0]!.runId)
    expect(snapshot.outcome?.kind).toBe("paused")
  })
})

describe("TB2-1: Provider 空截断轮不得触发 revise-plan", () => {
  // building 阶段 tracker + 纯文本轮（无工具调用）——旧代码会因
  // "步骤未推进" 触发 revise-plan；新代码只在工具实际执行但失败时允许。
  test("纯文本轮（无工具调用）不再触发 revise-plan", async () => {
    class TextOnlyProvider implements LLMProvider {
      async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
        yield { type: "text", data: "继续分析中……" }
      }
    }
    const trace = new MemoryTrace()
    const statuses: string[] = []
    const { decision } = await collectWithDecision(agentLoop("继续执行检查点恢复后的任务：读取 src/a.ts 与 src/b.ts 的当前内容，验证第一步的修改仍然存在并检查缓存状态，然后完成第二步剩余工作，最后运行 bun run typecheck 与测试确认无回归。", {
      provider: new TextOnlyProvider(),
      model: "test",
      tools: probeTool(),
      runTrace: trace as never,
      contextMapPolicy: "off",
      maxRounds: 3,
      // 种植 building 阶段 tracker（含未完成步骤）——旧代码在此必然 revise。
      resumeFromCheckpoint: {
        version: 1,
        round: 2,
        timestamp: 1_700_000_000_000,
        sessionId: "sess-revise",
        checkpointId: "cp-revise",
        masterPlan: {
          goal: "步骤目标",
          steps: [
            { id: "plan", title: "规划", status: "done" },
            { id: "s1", title: "第一步", status: "done" },
            { id: "s2", title: "第二步", status: "pending" },
          ],
        },
        taskSteps: [
          { id: "plan", title: "规划", status: "done" },
          { id: "s1", title: "第一步", status: "done" },
          { id: "s2", title: "第二步", status: "pending" },
        ],
        changedFiles: [],
        fileSHAs: {},
        coldMemorySHA: "",
        knowledgeCount: 0,
        lastVerification: null,
        conversationTokens: 0,
        prevRound: 1,
        summary: "第一步完成",
      },
    }))

    for (const e of trace.events) {
      if (e.type === "status") statuses.push(String(e.data))
    }
    // 空截断/纯文本轮绝不进入 revise-plan。
    const reviseEvents = trace.events.filter(e =>
      e.type === "gate_decision"
      && (e.data as { gate?: string } | undefined)?.gate === "revise_plan"
    )
    expect(reviseEvents).toHaveLength(0)
    // 终态必须不是完成（budget 耗尽无通过证据 → 未完成终止）。
    expect(decision.kind).toBe("break")
    if (decision.kind === "break") {
      expect(decision.reason).not.toBe("orchestrator_done")
      expect(decision.reason).not.toBe("verified_write")
    }
  })
})

describe("TB2-1: CLI 退出码与 Resume 校验（run-outcome 纯函数）", () => {
  test("退出码：0 完成 / 2 暂停 / 3 阻塞 / 4 失败", () => {
    expect(exitCodeForRunStatus("completed")).toBe(0)
    expect(exitCodeForRunStatus("paused")).toBe(2)
    expect(exitCodeForRunStatus("blocked")).toBe(3)
    expect(exitCodeForRunStatus("failed")).toBe(4)
  })

  test("classifyRunStatus：waiting→paused，cancelled→blocked，restart_required→failed", () => {
    expect(classifyRunStatus("completed")).toBe("completed")
    expect(classifyRunStatus("paused")).toBe("paused")
    expect(classifyRunStatus("waiting")).toBe("paused")
    expect(classifyRunStatus("blocked")).toBe("blocked")
    expect(classifyRunStatus("cancelled")).toBe("blocked")
    expect(classifyRunStatus("failed")).toBe("failed")
    expect(classifyRunStatus("restart_required")).toBe("failed")
  })

  test("validateResumeCheckpoint：自洽 checkpoint 通过", () => {
    const ok = validateResumeCheckpoint({
      version: 1,
      round: 3,
      timestamp: 1,
      sessionId: "s",
      checkpointId: "cp-ok",
      masterPlan: { goal: "g", nodes: [] },
      taskSteps: [
        { id: "plan", title: "规划", status: "done" },
        { id: "s1", title: "第一步", status: "done" },
        { id: "s2", title: "第二步", status: "pending" },
      ],
      changedFiles: ["a.ts"],
      fileSHAs: { "a.ts": "abc" },
      coldMemorySHA: "",
      knowledgeCount: 0,
      lastVerification: null,
      conversationTokens: 0,
      prevRound: 2,
      summary: "",
    })
    expect(ok.ok).toBe(true)
  })

  test("validateResumeCheckpoint：全部完成 / 步骤越界 / 文件记录不一致 → 拒绝", () => {
    const base: SessionCheckpoint = {
      version: 1,
      round: 3,
      timestamp: 1,
      sessionId: "s",
      checkpointId: "cp-x",
      masterPlan: {},
      taskSteps: [],
      changedFiles: [],
      fileSHAs: {},
      coldMemorySHA: "",
      knowledgeCount: 0,
      lastVerification: null,
      conversationTokens: 0,
      prevRound: 2,
      summary: "",
    }
    // 无任务步骤且无 masterPlan 节点 → 拒绝
    expect(validateResumeCheckpoint({ ...base }).ok).toBe(false)
    // 全部完成 → 无可恢复步骤 → 拒绝
    expect(validateResumeCheckpoint({
      ...base,
      taskSteps: [
        { id: "s1", title: "一", status: "done" },
        { id: "s2", title: "二", status: "done" },
      ],
    }).ok).toBe(false)
    // fileSHAs 有记录但 changedFiles 为空 → 拒绝
    expect(validateResumeCheckpoint({
      ...base,
      taskSteps: [{ id: "s1", title: "一", status: "pending" }],
      fileSHAs: { "a.ts": "abc" },
    }).ok).toBe(false)
    // 非法步骤状态 → 拒绝
    expect(validateResumeCheckpoint({
      ...base,
      taskSteps: [{ id: "s1", title: "一", status: "bogus" }],
    }).ok).toBe(false)
  })
})
