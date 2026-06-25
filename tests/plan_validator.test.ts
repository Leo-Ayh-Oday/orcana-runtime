import { describe, expect, test } from "bun:test"
import {
  validatePlan,
  validateNode,
  evaluatePlanForcePass,
  createMinimumViablePacket,
  formatValidationReport,
  type ValidationReport,
  type ValidationIssue,
} from "../src/agent/plan-validator"
import { createMasterPlan, createMasterPlanFromPacket, type MasterPlan } from "../src/agent/master-plan"
import { buildPacketFromLine } from "../src/agent/task-packet"

function planWithDeps(goal: string, nodeDefs: Array<{ title: string; dependsOn: string[] }>): MasterPlan {
  const plan = createMasterPlan(goal, "long_task", nodeDefs.map(d => d.title))
  // Override with explicit deps
  for (let i = 0; i < nodeDefs.length; i++) {
    plan.nodes[i]!.dependsOn = nodeDefs[i]!.dependsOn
  }
  return plan
}

// ── validatePlan: clean plan ──

describe("validatePlan — clean", () => {
  test("clean plan has no errors", () => {
    const plan = createMasterPlan("构建博客", "long_task", [
      "1. 创建package.json、tsconfig.json",
      "2. 创建server/index.ts、server/index.test.ts",
      "3. 运行typecheck、test验证",
    ])

    const report = validatePlan(plan)
    expect(report.isClean).toBe(true)
    expect(report.highRisk).toBe(false)
    expect(report.errors).toEqual([])
  })

  test("single-node plan validates clean", () => {
    const plan = createMasterPlan("G", "long_task", ["1. 做一件事"])

    const report = validatePlan(plan)
    expect(report.isClean).toBe(true)
  })
})

// ── validatePlan: cycle detection ──

describe("validatePlan — cycles", () => {
  test("detects direct 2-node cycle", () => {
    const plan = planWithDeps("G", [
      { title: "1. A", dependsOn: ["2"] },
      { title: "2. B", dependsOn: ["1"] },
    ])

    const report = validatePlan(plan)
    expect(report.isClean).toBe(false)
    expect(report.highRisk).toBe(true)
    expect(report.errors.some(e => e.check === "cycle")).toBe(true)
    expect(report.errors.some(e => e.message.includes("循环"))).toBe(true)
  })

  test("detects 3-node cycle", () => {
    const plan = planWithDeps("G", [
      { title: "1. A", dependsOn: ["3"] },
      { title: "2. B", dependsOn: ["1"] },
      { title: "3. C", dependsOn: ["2"] },
    ])

    const report = validatePlan(plan)
    expect(report.errors.some(e => e.check === "cycle")).toBe(true)
  })

  test("no false positive on linear DAG", () => {
    const plan = planWithDeps("G", [
      { title: "1. DB", dependsOn: [] },
      { title: "2. API", dependsOn: ["1"] },
      { title: "3. Frontend", dependsOn: ["2"] },
    ])

    const report = validatePlan(plan)
    expect(report.errors.some(e => e.check === "cycle")).toBe(false)
    expect(report.isClean).toBe(true)
  })

  test("no false positive on diamond DAG", () => {
    const plan = planWithDeps("G", [
      { title: "1. Base", dependsOn: [] },
      { title: "2. Branch A", dependsOn: ["1"] },
      { title: "3. Branch B", dependsOn: ["1"] },
      { title: "4. Merge", dependsOn: ["2", "3"] },
    ])

    const report = validatePlan(plan)
    expect(report.errors.some(e => e.check === "cycle")).toBe(false)
  })
})

// ── validatePlan: uniqueness ──

describe("validatePlan — uniqueness", () => {
  test("detects duplicate node IDs", () => {
    const plan = createMasterPlan("G", "long_task", ["1. A", "2. B"])
    // Force a duplicate
    plan.nodes[1]!.id = "1"

    const report = validatePlan(plan)
    expect(report.errors.some(e => e.check === "uniqueness")).toBe(true)
  })
})

// ── validatePlan: completeness ──

describe("validatePlan — completeness", () => {
  test("warns on empty doneCriteria", () => {
    const plan = createMasterPlan("G", "long_task", ["1. A"])
    // Clear doneCriteria in the packet
    plan.nodes[0]!._packet!.doneCriteria = []

    const report = validatePlan(plan)
    expect(report.warnings.some(w => w.check === "doneCriteria")).toBe(true)
  })

  test("errors on empty verification", () => {
    const plan = createMasterPlan("G", "long_task", ["1. A"])
    plan.nodes[0]!._packet!.verification = []

    const report = validatePlan(plan)
    expect(report.errors.some(e => e.check === "verification")).toBe(true)
  })

  test("warns on missing _packet", () => {
    const plan = createMasterPlan("G", "long_task", ["1. A"])
    plan.nodes[0]!._packet = undefined

    const report = validatePlan(plan)
    expect(report.warnings.some(w => w.check === "doneCriteria")).toBe(true)
  })
})

// ── validateNode ──

describe("validateNode", () => {
  test("error on missing node", () => {
    const plan = createMasterPlan("G", "long_task", ["1. A"])
    const issues = validateNode(plan, "99")
    expect(issues).toHaveLength(1)
    expect(issues[0]!.severity).toBe("error")
    expect(issues[0]!.check).toBe("existence")
  })

  test("clean node returns no issues", () => {
    const plan = createMasterPlan("G", "long_task", ["1. 创建package.json"])
    const issues = validateNode(plan, "1")
    expect(issues).toEqual([])
  })

  test("warns on empty doneCriteria for specific node", () => {
    const plan = createMasterPlan("G", "long_task", ["1. A", "2. B"])
    plan.nodes[1]!._packet!.doneCriteria = []
    const issues = validateNode(plan, "2")
    expect(issues.some(i => i.check === "doneCriteria")).toBe(true)
    // Node 1 should be fine
    expect(validateNode(plan, "1")).toEqual([])
  })
})

// ── createMinimumViablePacket ──

describe("createMinimumViablePacket", () => {
  test("creates packet with typecheck verification", () => {
    const packet = createMinimumViablePacket("构建博客应用")
    expect(packet.taskId).toContain("mvp-")
    expect(packet.nodeId).toBe("1")
    expect(packet.goal).toBe("构建博客应用")
    expect(packet.verification).toHaveLength(1)
    expect(packet.verification[0]!.kind).toBe("typecheck")
    expect(packet.verification[0]!.command).toBe("tsc --noEmit")
  })

  test("extracts file paths from rejected plan text", () => {
    const packet = createMinimumViablePacket(
      "博客",
      "需要创建 server/index.ts、client/src/App.tsx 和 package.json"
    )

    expect(packet.scope).toContain("server/index.ts")
    expect(packet.scope).toContain("client/src/App.tsx")
    expect(packet.scope).toContain("package.json")
  })

  test("fallback scope when plan text has no files", () => {
    const packet = createMinimumViablePacket("重构认证系统")
    expect(packet.scope).toEqual(["重构认证系统"])
    expect(packet.doneCriteria).toContain("typecheck 通过，核心逻辑可运行")
  })

  test("doneCriteria derived from extracted files", () => {
    const packet = createMinimumViablePacket("test", "创建 package.json、tsconfig.json")

    expect(packet.doneCriteria.some(c => c.includes("package.json"))).toBe(true)
    expect(packet.doneCriteria.some(c => c.includes("通过类型检查"))).toBe(true)
  })

  test("scope capped at 8 items", () => {
    const manyFiles = Array.from({ length: 15 }, (_, i) => `src/module${i}.ts`).join("、")
    const packet = createMinimumViablePacket("G", manyFiles)
    expect(packet.scope.length).toBeLessThanOrEqual(8)
  })
})

// ── evaluatePlanForcePass ──

describe("evaluatePlanForcePass", () => {
  test("blocks when below maxRounds", () => {
    const result = evaluatePlanForcePass({
      rejections: 1,
      maxRounds: 3,
      planText: "bad plan",
      goal: "博客",
    })

    expect(result.allow).toBe(false)
    expect(result.reason).toContain("2/3")
  })

  test("allows with fallback packet at threshold", () => {
    const result = evaluatePlanForcePass({
      rejections: 3,
      maxRounds: 3,
      planText: "bad plan with server/index.ts",
      goal: "博客",
    })

    expect(result.allow).toBe(true)
    expect(result.fallbackPacket).toBeDefined()
    expect(result.fallbackPacket!.verification).toHaveLength(1)
    expect(result.fallbackPacket!.verification[0]!.kind).toBe("typecheck")
  })

  test("default maxRounds = 3", () => {
    const blocked = evaluatePlanForcePass({
      rejections: 2,
      planText: "p",
      goal: "g",
    })
    expect(blocked.allow).toBe(false)

    const allowed = evaluatePlanForcePass({
      rejections: 3,
      planText: "p",
      goal: "g",
    })
    expect(allowed.allow).toBe(true)
  })
})

// ── formatValidationReport ──

describe("formatValidationReport", () => {
  test("empty string for clean report", () => {
    const plan = createMasterPlan("G", "long_task", ["1. 创建package.json"])
    const report = validatePlan(plan)
    expect(formatValidationReport(report)).toBe("")
  })

  test("includes error section for errors", () => {
    const plan = planWithDeps("G", [
      { title: "1. A", dependsOn: ["2"] },
      { title: "2. B", dependsOn: ["1"] },
    ])
    const report = validatePlan(plan)
    const formatted = formatValidationReport(report)
    expect(formatted).toContain("Plan Validator")
    expect(formatted).toContain("错误")
    expect(formatted).toContain("循环")
  })

  test("includes warning section", () => {
    const plan = createMasterPlan("G", "long_task", ["1. A"])
    plan.nodes[0]!._packet!.doneCriteria = []
    const report = validatePlan(plan)
    const formatted = formatValidationReport(report)
    expect(formatted).toContain("警告")
    expect(formatted).toContain("doneCriteria")
  })
})

// ── createMasterPlanFromPacket ──

describe("createMasterPlanFromPacket", () => {
  test("creates single-node plan from packet", () => {
    const packet = buildPacketFromLine({
      title: "创建server/index.ts",
      goal: "博客API",
      nodeId: "1",
    })

    const plan = createMasterPlanFromPacket(packet)
    expect(plan.nodes).toHaveLength(1)
    expect(plan.current).toBe("1")
    expect(plan.nodes[0]!.status).toBe("active")
    expect(plan.nodes[0]!._packet).toBe(packet)
    expect(plan._lastValidation).toBeDefined()
    expect(plan._lastValidation!.isClean).toBe(true)
  })

  test("force-pass packet creates valid plan", () => {
    const packet = createMinimumViablePacket("构建博客")
    const plan = createMasterPlanFromPacket(packet)

    const report = validatePlan(plan)
    expect(report.isClean).toBe(true)
    expect(report.highRisk).toBe(false)
  })
})

// ── validatePlan reports cached in MasterPlan._lastValidation ──

describe("MasterPlan._lastValidation", () => {
  test("createMasterPlan sets _lastValidation", () => {
    const plan = createMasterPlan("G", "long_task", ["1. A", "2. B"])
    expect(plan._lastValidation).toBeDefined()
    expect(plan._lastValidation!.isClean).toBe(true)
  })

  test("re-validate after mutating plan detects cycles", () => {
    const plan = planWithDeps("G", [
      { title: "1. A", dependsOn: ["2"] },
      { title: "2. B", dependsOn: ["1"] },
    ])
    // _lastValidation was set at create time with the mutated deps
    // But planWithDeps calls createMasterPlan (which validates WITH mutation) then overrides
    // So re-validate explicitly:
    plan._lastValidation = validatePlan(plan)
    expect(plan._lastValidation).toBeDefined()
    expect(plan._lastValidation!.highRisk).toBe(true)
    expect(plan._lastValidation!.errors.some(e => e.check === "cycle")).toBe(true)
  })
})
