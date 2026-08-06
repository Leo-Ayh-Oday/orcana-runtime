import { afterAll, describe, expect, test } from "bun:test"
import { agentLoop } from "../src/agent/loop"
import type { SessionCheckpoint } from "../src/session/checkpoint"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../src/provider/types"
import { buildTools, Result } from "../src/tools/registry"

// RC-11 D4 (CHECKPOINT_RESUME_USED): resumeFromCheckpoint 必须被 agentLoop 消费 —
// 恢复提示注入 round-0 消息序列（system，prompt 之前），masterPlan/taskTracker
// 水合后经 task_progress 事件可见（测试模式复用 agent_loop_l7_kernel.test.ts）。

const SAVED_ORCANA_FLASH_TRIAGE = process.env.ORCANA_FLASH_TRIAGE
process.env.ORCANA_FLASH_TRIAGE = "off"
afterAll(() => {
  if (SAVED_ORCANA_FLASH_TRIAGE === undefined) delete process.env.ORCANA_FLASH_TRIAGE
  else process.env.ORCANA_FLASH_TRIAGE = SAVED_ORCANA_FLASH_TRIAGE
})

/** 记录每次 provider 请求的 messages —— 捕获 round-0 消息组装结果。 */
class CapturingProvider implements LLMProvider {
  requests: Array<{ messages: ProviderCallOptions["messages"] }> = []
  rounds = 0

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.requests.push({ messages: options.messages ?? [] })
    if (this.rounds++ === 0) {
      yield { type: "tool_call", data: { id: "probe-1", name: "baseline_probe", input: {} } }
      return
    }
    yield { type: "text", data: "resumed answer." }
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

// 通过澄清门（normalizedLength ≥ 80 且 specificity ≥ 3）：有 tracker 时短而模糊的提示会触发澄清。
const RESUME_PROMPT = "继续执行检查点恢复后的任务：读取 src/a.ts 与 src/b.ts 的当前内容，验证第一步的修改仍然存在并检查缓存状态，然后完成第二步剩余工作，最后运行 bun run typecheck 与测试确认无回归。"

function makeCheckpoint(overrides?: Partial<SessionCheckpoint>): SessionCheckpoint {
  return {
    version: 1,
    round: 2,
    timestamp: 1_700_000_000_000,
    sessionId: "sess-d4",
    checkpointId: "cp-d4",
    masterPlan: {
      goal: "D4 目标",
      nodes: [
        { id: "1", title: "第一步", status: "done", evidence: "证据1" },
        { id: "2", title: "第二步", status: "active" },
        { id: "3", title: "第三步", status: "pending" },
      ],
      current: "2",
    },
    taskSteps: [
      { id: "1", title: "第一步", status: "done" },
      { id: "2", title: "第二步", status: "running" },
      { id: "3", title: "第三步", status: "pending" },
    ],
    changedFiles: ["a.ts"],
    fileSHAs: {},
    coldMemorySHA: "",
    knowledgeCount: 0,
    lastVerification: null,
    conversationTokens: 0,
    prevRound: 1,
    summary: "已完成第一步",
    ...overrides,
  }
}

async function collect(iterable: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const event of iterable) events.push(event)
  return events
}

describe("RC-11 D4 CHECKPOINT_RESUME_USED", () => {
  test("恢复提示注入 round-0 消息（system，prompt 之前）", async () => {
    const provider = new CapturingProvider()
    await collect(agentLoop(RESUME_PROMPT, {
      provider,
      model: "test",
      tools: probeTool(),
      resumeFromCheckpoint: makeCheckpoint(),
      contextMapPolicy: "off",
      maxRounds: 2,
    }))
    expect(provider.requests.length).toBeGreaterThan(0)
    const messages = provider.requests[0]!.messages
    expect(messages.at(-1)!.content).toBe(RESUME_PROMPT)
    const recovery = messages.find(m => m.role === "system" && typeof m.content === "string" && m.content.includes("会话恢复 — 从检查点继续"))
    expect(recovery).toBeDefined()
    expect(messages.indexOf(recovery!)).toBeLessThan(messages.length - 1)
  })

  test("nodes 形状 checkpoint 恢复 masterPlan 与节点状态（task_progress 可见）", async () => {
    const events = await collect(agentLoop(RESUME_PROMPT, {
      provider: new CapturingProvider(),
      model: "test",
      tools: probeTool(),
      resumeFromCheckpoint: makeCheckpoint(),
      contextMapPolicy: "off",
      maxRounds: 2,
    }))
    const progress = events.filter(e => e.type === "task_progress")
    expect(progress.length).toBeGreaterThan(0)
    const snapshot = progress[0]!.data as {
      goal: string
      phase: string
      done: number
      total: number
      steps: Array<{ id: string; status: string }>
    }
    // 节点子跟踪器 goal 修饰为 `${plan.goal} — ${node.title}`（task-packet.ts）——
    // 同时证明节点 2 的 tracker 被水合且 plan.current="2" 生效
    expect(snapshot.goal).toBe("D4 目标 — 第二步")
    expect(snapshot.done).toBe(1)
    expect(snapshot.total).toBe(3)
    expect(snapshot.steps.find(s => s.id === "1")!.status).toBe("done")
    expect(snapshot.steps.find(s => s.id === "2")!.status).toBe("running")
  })

  test("steps 形状 checkpoint 恢复 TaskTracker（phase building 直接继续执行）", async () => {
    const events = await collect(agentLoop(RESUME_PROMPT, {
      provider: new CapturingProvider(),
      model: "test",
      tools: probeTool(),
      resumeFromCheckpoint: makeCheckpoint({
        masterPlan: {
          goal: "steps 目标",
          steps: [
            { id: "s1", title: "步骤一", status: "done" },
            { id: "s2", title: "步骤二", status: "pending" },
          ],
        },
      }),
      contextMapPolicy: "off",
      maxRounds: 2,
    }))
    const progress = events.filter(e => e.type === "task_progress")
    expect(progress.length).toBeGreaterThan(0)
    const snapshot = progress[0]!.data as {
      goal: string
      phase: string
      done: number
      total: number
      steps: Array<{ id: string; status: string }>
    }
    expect(snapshot.goal).toBe("steps 目标")
    expect(snapshot.phase).toBe("building")
    expect(snapshot.total).toBe(2)
    expect(snapshot.steps.find(s => s.id === "s1")!.status).toBe("done")
    expect(snapshot.steps.find(s => s.id === "s2")!.status).toBe("pending")
  })

  test("无计划数据的 checkpoint 不阻断执行（水合跳过）", async () => {
    const provider = new CapturingProvider()
    const events = await collect(agentLoop(RESUME_PROMPT, {
      provider,
      model: "test",
      tools: probeTool(),
      resumeFromCheckpoint: makeCheckpoint({ masterPlan: {}, taskSteps: [] }),
      contextMapPolicy: "off",
      maxRounds: 2,
    }))
    expect(provider.requests.length).toBeGreaterThan(0)
    expect(events.filter(e => e.type === "text").some(e => e.data === "resumed answer.")).toBe(true)
  })

  test("masterPlan 无 nodes/steps 时回退 checkpoint.taskSteps 恢复 tracker", async () => {
    const events = await collect(agentLoop(RESUME_PROMPT, {
      provider: new CapturingProvider(),
      model: "test",
      tools: probeTool(),
      resumeFromCheckpoint: makeCheckpoint({ masterPlan: { goal: "扁平目标" } }),
      contextMapPolicy: "off",
      maxRounds: 2,
    }))
    const progress = events.filter(e => e.type === "task_progress")
    expect(progress.length).toBeGreaterThan(0)
    const snapshot = progress[0]!.data as {
      goal: string
      phase: string
      done: number
      total: number
      steps: Array<{ id: string; status: string }>
    }
    expect(snapshot.goal).toBe("扁平目标")
    expect(snapshot.phase).toBe("building")
    expect(snapshot.done).toBe(1)
    expect(snapshot.total).toBe(3)
    expect(snapshot.steps.find(s => s.id === "2")!.status).toBe("running")
  })
})
