import { describe, expect, test } from "bun:test"
import {
  createMasterPlan,
  nodesFromPlanText,
  markNodeDone,
  buildNodeReviewGate,
  activateNode,
  planComplete,
  currentNode,
  planProgress,
  planRef,
  blockTask,
  autoUnblockByRipple,
} from "../src/agent/master-plan"
import { agentLoop } from "../src/agent/loop"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../src/provider/types"
import { buildTools, Result } from "../src/tools/registry"

describe("nodesFromPlanText", () => {
  test("extracts numbered nodes from a plan", () => {
    const text = [
      "## 项目计划",
      "1. 创建数据库模型",
      "2. 创建API接口",
      "3. 前后端联调",
    ].join("\n")

    const nodes = nodesFromPlanText(text)
    expect(nodes.length).toBe(3)
    expect(nodes[0]!.title).toBe("1. 创建数据库模型")
    expect(nodes[1]!.title).toBe("2. 创建API接口")
    expect(nodes[2]!.title).toBe("3. 前后端联调")
  })

  test("detects integration/联调 nodes and adds dependencies", () => {
    const text = [
      "1. 数据库",
      "2. API",
      "3. 前后端联调测试",
    ].join("\n")

    const nodes = nodesFromPlanText(text)
    expect(nodes[2]!.dependsOn).toEqual([1, 2])
  })

  test("returns empty for prose text without numbered items", () => {
    const nodes = nodesFromPlanText("This project needs a database and API.")
    expect(nodes.length).toBe(0)
  })

  test("handles mixed format (dash, dot, bracket)", () => {
    const text = [
      "- 第一步: 搭建基础",
      "2) 第二步: 实现功能",
      "3、第三步: 验证联调",
    ].join("\n")

    const nodes = nodesFromPlanText(text)
    expect(nodes.length).toBe(3)
    expect(nodes[2]!.dependsOn).toEqual([1, 2])
  })

  test("skips empty lines and non-list lines", () => {
    const text = [
      "## 说明",
      "这是一个多阶段任务",
      "",
      "1. 第一阶段: 基础搭建",
      "  详细说明...",
      "2. 第二阶段: 核心功能",
    ].join("\n")

    const nodes = nodesFromPlanText(text)
    expect(nodes.length).toBe(2)
  })
})

describe("createMasterPlan", () => {
  test("creates plan with first node active", () => {
    const plan = createMasterPlan("build a blog", "long_task", ["1. 数据库", "2. API", "3. 前端"])

    expect(plan.goal).toBe("build a blog")
    expect(plan.nodes.length).toBe(3)
    expect(plan.current).toBe("1")
    expect(plan.nodes[0]!.status).toBe("active")
    expect(plan.nodes[1]!.status).toBe("pending")
    expect(plan.nodes[2]!.status).toBe("pending")
  })

  test("each node has a task tracker", () => {
    const plan = createMasterPlan("test", "long_task", ["node 1", "node 2"])

    for (const node of plan.nodes) {
      expect(node.tracker).toBeDefined()
      expect(node.tracker.goal).toContain("test")
    }
  })

  test("sets planRef.current", () => {
    const plan = createMasterPlan("g", "long_task", ["n1"])
    planRef.current = plan
    expect(planRef.current).toBe(plan)
  })
})

describe("node lifecycle", () => {
  test("markNodeDone → planProgress reflects completion", () => {
    const plan = createMasterPlan("g", "long_task", ["1. A", "2. B", "3. C"])

    markNodeDone(plan, "1", "done")
    expect(plan.nodes[0]!.status).toBe("done")
    expect(plan.nodes[0]!.evidence).toBe("done")
    expect(planProgress(plan)).toBe("1/3 节点完成")
    expect(planComplete(plan)).toBe(false)
  })

  test("planComplete returns true when all done", () => {
    const plan = createMasterPlan("g", "long_task", ["1. A", "2. B"])

    markNodeDone(plan, "1")
    markNodeDone(plan, "2")
    expect(planComplete(plan)).toBe(true)
  })

  test("buildNodeReviewGate activates next node after completion", () => {
    const plan = createMasterPlan("g", "long_task", ["1. A", "2. B", "3. C"])

    markNodeDone(plan, "1", "evidence 1")
    const review = buildNodeReviewGate(plan, "1")

    // Should auto-activate node 2
    expect(review.resume).toBe(true)
    expect(review.remaining).toBe(2)
    const cur = currentNode(plan)
    expect(cur).toBeDefined()
    expect(cur!.id).toBe("2")
    expect(cur!.status).toBe("active")
  })

  test("buildNodeReviewGate returns plan_complete when all done", () => {
    const plan = createMasterPlan("g", "long_task", ["1. A", "2. B"])

    markNodeDone(plan, "1")
    markNodeDone(plan, "2")
    const review = buildNodeReviewGate(plan, "2")

    expect(review.resume).toBe(true)
    expect(review.remaining).toBe(0)
    expect(review.promptText).toContain("主计划全部完成")
  })

  test("buildNodeReviewGate prompt includes plan status table", () => {
    const plan = createMasterPlan("build blog", "long_task", ["1. DB", "2. API"])

    markNodeDone(plan, "1")
    const review = buildNodeReviewGate(plan, "1")

    expect(review.promptText).toContain("DB")
    expect(review.promptText).toContain("API")
    expect(review.promptText).toContain("主计划状态")
    expect(review.promptText).toContain("✅")
  })

  test("activateNode blocks when dependency not satisfied", () => {
    const plan = createMasterPlan("g", "long_task", ["1. A", "2. B", "3. C"])
    // B depends on A
    plan.nodes[1]!.dependsOn = ["1"]
    plan.nodes[1]!.status = "pending"

    // Try to activate B before A is done
    const result = activateNode(plan, "2")
    expect(result).toBeNull()
    expect(currentNode(plan)!.id).toBe("1") // still A
  })

  test("activateNode succeeds when dependency is done", () => {
    const plan = createMasterPlan("g", "long_task", ["1. A", "2. B", "3. C"])
    plan.nodes[1]!.dependsOn = ["1"]
    plan.nodes[1]!.status = "pending"

    markNodeDone(plan, "1")
    const result = activateNode(plan, "2")
    expect(result).not.toBeNull()
    expect(currentNode(plan)!.id).toBe("2")
  })
})

describe("blockTask / autoUnblockByRipple", () => {
  test("blockTask creates bidirectional edge", () => {
    const plan = createMasterPlan("g", "long_task", ["1. A", "2. B"])
    blockTask(plan, "1", "2")

    expect(plan.nodes[0]!.blockedBy).toContain("2")
    expect(plan.nodes[1]!.dependsOn).toContain("1")
  })

  test("autoUnblockByRipple unblocks nodes with satisfied deps", () => {
    const plan = createMasterPlan("g", "long_task", ["1. A", "2. B", "3. C"])
    plan.nodes[1]!.dependsOn = ["1"]
    plan.nodes[1]!.status = "blocked"
    plan.nodes[2]!.dependsOn = ["1"]
    plan.nodes[2]!.status = "blocked"

    markNodeDone(plan, "1")
    const count = autoUnblockByRipple(plan)
    expect(count).toBe(2)
    expect(plan.nodes[1]!.status as string).toBe("pending")
    expect(plan.nodes[2]!.status as string).toBe("pending")
  })
})

describe("planRef", () => {
  test("shared reference across agent modules", () => {
    const plan = createMasterPlan("g", "long_task", ["1. A"])
    planRef.current = plan

    expect(planRef.current).toBe(plan)
    expect(currentNode(plan)!.id).toBe("1")

    // Simulate what CLI would read
    expect(planRef.current?.nodes[0]!.title).toBe("1. A")
  })
})

// ── Integration test: MasterPlan node transition via agentLoop ──

/** Mock provider that outputs a multi-node plan then completes each node. */
class MasterPlanNodeTransitionProvider implements LLMProvider {
  rounds = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    if (this.rounds === 0) {
      // Output a plan with numbered nodes that passes planning-gate evaluation
      yield {
        type: "text",
        data: [
          "## 目标与范围",
          "构建全栈博客应用。范围：数据库模型、Bun API接口、React前端页面、测试与构建验证。不包含：部署、认证。",
          "",
          "## 假设与不确定性",
          "项目目录可能为空，需要从零创建package.json和tsconfig.json。假设使用TypeScript、Bun、React/Vite。",
          "",
          "## 风险与取舍",
          "方案A：最小MVP先验证核心链路（选这个）。方案B：完整博客系统含评论和搜索。选A，理由：每步可验证、边界清晰、降低首次交付风险。",
          "",
          "## 执行步骤",
          "- 创建package.json、tsconfig.json、项目结构",
          "- 创建server/index.ts、server/index.test.ts，实现API接口和错误处理",
          "- 创建client/src/App.tsx、client/src/App.css，实现响应式前端页面和阅读页排版",
          "- 运行typecheck、test、build三个验证命令，确保全部通过",
        ].join("\n"),
      }
      this.rounds++
      return
    }
    // Subsequent rounds: short "done" completion text
    yield { type: "text", data: "当前步骤完成，验证通过。" }
    this.rounds++
  }
}

describe("MasterPlan loop integration", () => {
  test("auto-approved multi-node plan creates MasterPlan", async () => {
    const provider = new MasterPlanNodeTransitionProvider()
    const events: StreamEvent[] = []

    for await (const event of agentLoop("Build a full-stack blog with React/Vite, Bun API, tests, responsive design, and build verification.", {
      provider,
      model: "test",
      tools: [],
      maxRounds: 3,
      autoApprovePlan: true,
      flashTriagePolicy: "off",
      conversationHistory: [
        { role: "user", content: "Build a full-stack blog with React/Vite, Bun API, tests, responsive design, and build verification." },
        { role: "assistant", content: "[clarification-gate]\n## 需求确认" },
      ],
    })) {
      events.push(event)
    }

    // MasterPlan status should be yielded after plan acceptance
    const planStatuses = events.filter(e =>
      e.type === "status" && String(e.data).includes("master-plan:")
    )
    // With auto-approved multi-node plan, MasterPlan should be activated
    expect(planStatuses.length).toBeGreaterThan(0)
    expect(planStatuses.some(e => String(e.data).includes("nodes"))).toBe(true)
    expect(provider.rounds).toBeGreaterThan(0)
  })

  test("plan_ready yield includes plan context for CLI approval flow", async () => {
    // Use a long_task prompt with conversation history to bypass clarification gate
    let round = 0
    const provider: LLMProvider = {
      async *streamChat(_opts: ProviderCallOptions): AsyncGenerator<StreamEvent> {
        round++
        if (round === 1) {
          yield {
            type: "text",
            data: [
              "## 目标与范围",
              "构建全栈博客。范围：数据库、API、前端。不包含：部署。",
              "",
              "## 假设与不确定性",
              "项目目录可能为空。假设使用React和Bun。",
              "",
              "## 风险与取舍",
              "方案A：最小MVP。方案B：完整实现。选A，理由：快速验证。",
              "",
              "## 执行步骤",
              "1. 创建数据库模型",
              "2. 实现API接口",
              "3. 创建前端页面",
              "4. 集成测试",
            ].join("\n"),
          }
          return
        }
        yield { type: "text", data: "done" }
      },
    }

    const events: StreamEvent[] = []
    for await (const event of agentLoop("Build a full-stack blog with React, Bun API, and tests", {
      provider,
      model: "test",
      tools: [],
      maxRounds: 3,
      flashTriagePolicy: "off",
      conversationHistory: [
        { role: "user", content: "Build a full-stack blog with React/Vite, Bun API, tests, responsive design, and build verification." },
        { role: "assistant", content: "[clarification-gate]\n## 需求确认" },
      ],
    })) {
      events.push(event)
    }

    // Without autoApprovePlan, plan_ready should be yielded for a passing plan
    const planReady = events.find(e => e.type === "plan_ready")
    expect(planReady).toBeDefined()
    const data = planReady?.data as { planText?: string; goal?: string; steps?: unknown[] } | undefined
    expect(data?.planText).toBeDefined()
    expect(data?.steps).toBeDefined()
  })
})
