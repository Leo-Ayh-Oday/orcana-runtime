/** G2 acceptance: stable compilation from MasterPlan (+TaskPackets). */

import { describe, expect, test } from "bun:test"
import { compileMasterPlan, type PlanLike } from "../../src/workflow/compiler/master-plan-adapter"

const PLAN: PlanLike = {
  goal: "audit the payment module",
  intent: "audit",
  nodes: [
    {
      id: "1",
      title: "调研支付模块结构",
      dependsOn: [],
      _packet: {
        goal: "read and analyze the payment module files",
        scope: ["src/payment/"],
        doneCriteria: ["understand structure"],
        contextBudget: { maxToolCalls: 10 },
      },
    },
    {
      id: "2",
      title: "检查变更历史",
      dependsOn: ["1"],
    },
    {
      id: "3",
      title: "定位支付核心符号",
      dependsOn: ["1"],
    },
  ],
}

describe("G2 master-plan compiler", () => {
  test("same input produces a stable graph", () => {
    const a = compileMasterPlan(PLAN)
    const b = compileMasterPlan(PLAN)
    expect(a.specId).toBe(b.specId)
    expect(JSON.stringify(a.nodes)).toBe(JSON.stringify(b.nodes))
  })

  test("graph schema is versioned", () => {
    expect(compileMasterPlan(PLAN).schemaVersion).toBe("0.1")
  })

  test("plan nodes compile to read-only handlers (packet + inference)", () => {
    const spec = compileMasterPlan(PLAN)
    expect(spec.nodes).toHaveLength(3)
    expect(spec.nodes.map(n => n.id)).toEqual(["plan:1", "plan:2", "plan:3"])
    expect(spec.nodes.find(n => n.id === "plan:1")!.handler).toBe("tool.read_file")
    expect(spec.nodes.find(n => n.id === "plan:2")!.handler).toBe("tool.git_status")
    expect(spec.nodes.find(n => n.id === "plan:3")!.handler).toBe("tool.find_symbol")
  })

  test("dependsOn edges are preserved and deduplicated", () => {
    const spec = compileMasterPlan(PLAN)
    const node2 = spec.nodes.find(n => n.id === "plan:2")!
    expect(node2.dependsOn).toEqual(["plan:1"])
  })

  test("node without a packet and without inferable intent fails loudly", () => {
    const bad: PlanLike = {
      goal: "build a feature",
      intent: "coding",
      nodes: [{ id: "1", title: "实现计费逻辑", dependsOn: [] }],
    }
    expect(() => compileMasterPlan(bad)).toThrow(/cannot compile plan node/)
  })

  test("stable ordering: topological order is deterministic", () => {
    const spec = compileMasterPlan(PLAN)
    const order = spec.nodes.map(n => n.id)
    // node 2 and 3 both depend on 1; either order is fine but must repeat.
    expect(compileMasterPlan(PLAN).nodes.map(n => n.id)).toEqual(order)
  })
})
