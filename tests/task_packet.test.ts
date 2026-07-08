import { describe, expect, test } from "bun:test"
import {
  extractScopeFromLine,
  isFilePath,
  buildPacketFromLine,
  createTaskTrackerFromPacket,
  parseTaskPacketJson,
  validateTaskPacketJsonShape,
  TASK_PACKET_JSON_SCHEMA,
  DEFAULT_RIPPLE,
  DEFAULT_BUDGET,
  type TaskPacket,
  type ScopeExtraction,
} from "../src/agent/task-packet"
import { addNode, createMasterPlan, currentNode, revisePlan, serializePlan } from "../src/agent/master-plan"
import { markPlanAccepted, taskTrackerComplete, updateTaskTrackerAfterTools } from "../src/agent/task-tracker"

// ── isFilePath ──

describe("isFilePath", () => {
  test("recognizes file extensions", () => {
    expect(isFilePath("server/index.ts")).toBe(true)
    expect(isFilePath("package.json")).toBe(true)
    expect(isFilePath("tsconfig.json")).toBe(true)
    expect(isFilePath("client/src/App.tsx")).toBe(true)
    expect(isFilePath("client/src/App.css")).toBe(true)
    expect(isFilePath("README.md")).toBe(true)
    expect(isFilePath(".env")).toBe(true)
    expect(isFilePath("Dockerfile")).toBe(false) // not in our pattern
  })

  test("rejects abstract descriptions", () => {
    expect(isFilePath("实现API接口")).toBe(false)
    expect(isFilePath("运行类型检查")).toBe(false)
    expect(isFilePath("前后端联调")).toBe(false)
  })
})

// ── extractScopeFromLine ──

describe("extractScopeFromLine", () => {
  test("extracts file paths from a plan line", () => {
    const result = extractScopeFromLine("创建package.json、tsconfig.json、项目结构")
    expect(result.files).toContain("package.json")
    expect(result.files).toContain("tsconfig.json")
    expect(result.deliverable).toContain("项目结构")
  })

  test("extracts nested file paths", () => {
    const result = extractScopeFromLine("创建server/index.ts、server/index.test.ts，实现API接口和错误处理")
    expect(result.files).toContain("server/index.ts")
    expect(result.files).toContain("server/index.test.ts")
    expect(result.deliverable).toContain("API")
  })

  test("detects verification hints — typecheck, test, build", () => {
    const result = extractScopeFromLine("运行typecheck、test、build三个验证命令，确保全部通过")
    expect(result.verificationHints).toContain("typecheck")
    expect(result.verificationHints).toContain("test")
    expect(result.verificationHints).toContain("build")
    expect(result.files).toEqual([])
  })

  test("detects lint verification hint", () => {
    const result = extractScopeFromLine("运行eslint检查代码风格")
    expect(result.verificationHints).toContain("lint")
  })

  test("strips number prefix", () => {
    // All three formats should produce the same deliverable content
    const r1 = extractScopeFromLine("1. 创建数据库模型")
    const r2 = extractScopeFromLine("1) 创建数据库模型")
    const r3 = extractScopeFromLine("1、创建数据库模型")
    expect(r1.deliverable).toBe("创建数据库模型")
    expect(r2.deliverable).toBe("创建数据库模型")
    expect(r3.deliverable).toBe("创建数据库模型")
  })

  test("strips dash prefix", () => {
    const result = extractScopeFromLine("- 创建前端页面")
    expect(result.deliverable).toBe("创建前端页面")
  })

  test("no files, no verification → empty arrays", () => {
    const result = extractScopeFromLine("审查代码质量")
    expect(result.files).toEqual([])
    expect(result.verificationHints).toEqual([])
    expect(result.deliverable).toBe("审查代码质量")
  })

  test("deduplicates files", () => {
    // package.json could match both file and path pattern
    const result = extractScopeFromLine("创建package.json和server/package.json")
    expect(result.files.filter(f => f === "package.json").length).toBe(1)
  })

  test("rejects dotted version strings as false-positive file paths", () => {
    // "version-2.0.ts" should NOT extract "0.ts"
    const result = extractScopeFromLine("确保兼容 version-2.0.ts 的运行时行为")
    // The plan line contains version-2.0.ts but our regex should NOT match 0.ts
    expect(result.files.includes("0.ts")).toBe(false)
    // But it should find real files
    expect(result.files.includes("2.0.ts")).toBe(false) // would need a real-word prefix
  })

  test("extracts .gitignore when referenced in plan text", () => {
    const result = extractScopeFromLine("创建.gitignore、.env配置文件")
    expect(result.files).toContain(".gitignore")
    expect(result.files).toContain(".env")
  })
})

// ── buildPacketFromLine ──

describe("buildPacketFromLine", () => {
  test("builds packet with file scope", () => {
    const packet = buildPacketFromLine({
      title: "1. 创建package.json、tsconfig.json、项目结构",
      goal: "构建博客应用",
      nodeId: "1",
    })

    expect(packet.taskId).toBe("task-1")
    expect(packet.nodeId).toBe("1")
    expect(packet.goal).toBe("构建博客应用")
    expect(packet.scope).toContain("package.json")
    expect(packet.scope).toContain("tsconfig.json")
    expect(packet.doneCriteria.length).toBeGreaterThan(0)
    expect(packet.ripplePolicy.autoPropagate).toBe(true)
    expect(packet.contextBudget.maxToolsPerNode).toBe(20)
  })

  test("builds packet with verification hints", () => {
    const packet = buildPacketFromLine({
      title: "运行typecheck、test、build验证",
      goal: "构建博客应用",
      nodeId: "4",
    })

    expect(packet.verification.length).toBe(3)
    const kinds = packet.verification.map(v => v.kind)
    expect(kinds).toContain("typecheck")
    expect(kinds).toContain("test")
    expect(kinds).toContain("build")
  })

  test("fallback verification when no hints detected", () => {
    const packet = buildPacketFromLine({
      title: "创建数据库模型",
      goal: "构建博客应用",
      nodeId: "1",
    })

    expect(packet.verification.length).toBe(1)
    expect(packet.verification[0]!.kind).toBe("typecheck")
  })

  test("custom taskId", () => {
    const packet = buildPacketFromLine({
      title: "API",
      goal: "g",
      nodeId: "3",
      taskId: "custom-xyz",
    })

    expect(packet.taskId).toBe("custom-xyz")
  })

  test("deliverable used as scope when no files detected", () => {
    const packet = buildPacketFromLine({
      title: "前后端联调测试",
      goal: "博客",
      nodeId: "3",
    })

    expect(packet.scope).toEqual(["前后端联调测试"])
  })

  test("verification commands populated alongside descriptions", () => {
    const packet = buildPacketFromLine({
      title: "运行typecheck、test验证",
      goal: "博客",
      nodeId: "2",
    })

    expect(packet.verification).toHaveLength(2)
    for (const v of packet.verification) {
      expect(v.command).toBeDefined()
      expect(v.command!.length).toBeGreaterThan(0)
      expect(v.description).toBeDefined()
    }
    expect(packet.verification[0]!.command).toBe("tsc --noEmit")
    expect(packet.verification[1]!.command).toBe("bun test")
  })

  test("doneCriteria for verification-only nodes uses verify-focused fallback", () => {
    const packet = buildPacketFromLine({
      title: "运行typecheck、test、build验证命令",
      goal: "博客",
      nodeId: "4",
    })

    // No files extracted → doneCriteria should come from verification hints
    expect(packet.doneCriteria).toHaveLength(3)
    expect(packet.doneCriteria.some(c => c.includes("类型检查"))).toBe(true)
    expect(packet.doneCriteria.some(c => c.includes("测试"))).toBe(true)
  })
})

// ── TaskPacket JSON schema ──

describe("TaskPacket JSON schema", () => {
  test("exports a strict JSON schema for structured model output", () => {
    expect(TASK_PACKET_JSON_SCHEMA.type).toBe("object")
    expect(TASK_PACKET_JSON_SCHEMA.additionalProperties).toBe(false)
    expect(TASK_PACKET_JSON_SCHEMA.required).toContain("taskId")
    expect(TASK_PACKET_JSON_SCHEMA.required).toContain("verification")
    const verification = TASK_PACKET_JSON_SCHEMA.properties.verification
    expect(verification.items.properties.kind.enum).toContain("typecheck")
  })

  test("parses valid TaskPacket JSON into a typed packet", () => {
    const raw = buildPacketFromLine({
      title: "Update src/agent/task-packet.ts and run typecheck",
      goal: "schema validation",
      nodeId: "1",
    })

    const parsed = parseTaskPacketJson(raw)

    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.packet.taskId).toBe("task-1")
      expect(parsed.packet.scope).toContain("src/agent/task-packet.ts")
      expect(parsed.packet.verification[0]!.kind).toBe("typecheck")
    }
  })

  test("rejects missing required fields before TaskPacket execution", () => {
    const raw = {
      taskId: "task-1",
      nodeId: "1",
      title: "T",
      goal: "G",
      scope: ["src/a.ts"],
      doneCriteria: ["done"],
      ripplePolicy: { ...DEFAULT_RIPPLE },
      contextBudget: { ...DEFAULT_BUDGET },
    }

    const parsed = parseTaskPacketJson(raw)

    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.errors.join("\n")).toContain("TaskPacket.verification is required")
    }
  })

  test("rejects wrong field types and extra properties", () => {
    const raw = {
      ...buildPacketFromLine({ title: "Update src/a.ts", goal: "G", nodeId: "1" }),
      scope: "src/a.ts",
      unexpected: true,
    }

    const errors = validateTaskPacketJsonShape(raw)

    expect(errors.join("\n")).toContain("TaskPacket.scope must be an array")
    expect(errors.join("\n")).toContain("TaskPacket.unexpected is not allowed")
  })

  test("rejects invalid verification kinds fail-closed", () => {
    const raw = buildPacketFromLine({ title: "Update src/a.ts", goal: "G", nodeId: "1" }) as TaskPacket
    raw.verification = [{ kind: "deploy" as TaskPacket["verification"][number]["kind"], description: "deploy" }]

    const parsed = parseTaskPacketJson(raw)

    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.errors.join("\n")).toContain("verification[0].kind")
    }
    expect(() => createTaskTrackerFromPacket(raw)).toThrow("TaskPacket validation failed")
  })
})

// ── createTaskTrackerFromPacket ──

describe("createTaskTrackerFromPacket", () => {
  test("creates tracker with scope-derived steps", () => {
    const packet: TaskPacket = {
      taskId: "t1",
      nodeId: "1",
      title: "数据库",
      goal: "博客",
      scope: ["package.json", "server/db.ts"],
      doneCriteria: ["文件已创建"],
      verification: [{ kind: "typecheck", description: "运行tsc" }],
      ripplePolicy: { ...DEFAULT_RIPPLE },
      contextBudget: { ...DEFAULT_BUDGET },
    }

    const tracker = createTaskTrackerFromPacket(packet)

    expect(tracker.goal).toContain("博客")
    expect(tracker.goal).toContain("数据库")
    expect(tracker.phase).toBe("building")
    expect(tracker.intent).toBe("long_task")
    expect(tracker.steps.length).toBe(3) // 2 scope + 1 verify
    expect(tracker.steps[0]!.id).toBe("scope-1")
    expect(tracker.steps[0]!.status).toBe("running")
    expect(tracker.steps[1]!.status).toBe("pending")
    expect(tracker.requiredFiles).toContain("server/db.ts")
    expect(tracker.requiredVerificationKinds).toEqual(["typecheck"])
  })

  test("first scope item is running, others pending", () => {
    const packet: TaskPacket = {
      taskId: "t1",
      nodeId: "1",
      title: "T",
      goal: "G",
      scope: ["a.ts", "b.ts", "c.ts"],
      doneCriteria: [],
      verification: [{ kind: "typecheck", description: "运行 tsc" }],
      ripplePolicy: { ...DEFAULT_RIPPLE },
      contextBudget: { ...DEFAULT_BUDGET },
    }

    const tracker = createTaskTrackerFromPacket(packet)
    expect(tracker.steps[0]!.status).toBe("running")
    expect(tracker.steps[1]!.status).toBe("pending")
    expect(tracker.steps[2]!.status).toBe("pending")
  })

  test("minimal scope with verification", () => {
    const packet: TaskPacket = {
      taskId: "t1",
      nodeId: "1",
      title: "实现核心功能",
      goal: "G",
      scope: ["实现核心逻辑"],
      doneCriteria: ["核心逻辑已实现"],
      verification: [{ kind: "typecheck", description: "运行 tsc" }],
      ripplePolicy: { ...DEFAULT_RIPPLE },
      contextBudget: { ...DEFAULT_BUDGET },
    }

    const tracker = createTaskTrackerFromPacket(packet)
    expect(tracker.steps.length).toBe(2) // 1 scope + 1 verify
    expect(tracker.steps[0]!.id).toBe("scope-1")
    expect(tracker.steps[0]!.status).toBe("running")
  })

  test("marks files as required, skips abstract descriptions", () => {
    const packet: TaskPacket = {
      taskId: "t1",
      nodeId: "1",
      title: "T",
      goal: "G",
      scope: ["实现API", "server/index.ts", "添加错误处理"],
      doneCriteria: [],
      verification: [{ kind: "typecheck", description: "运行 tsc" }],
      ripplePolicy: { ...DEFAULT_RIPPLE },
      contextBudget: { ...DEFAULT_BUDGET },
    }

    const tracker = createTaskTrackerFromPacket(packet)
    expect(tracker.requiredFiles).toEqual(["server/index.ts"])
  })

  test("verification steps have correct step IDs", () => {
    const packet: TaskPacket = {
      taskId: "t1",
      nodeId: "1",
      title: "T",
      goal: "G",
      scope: ["a.ts"],
      doneCriteria: [],
      verification: [
        { kind: "typecheck", description: "运行 tsc" },
        { kind: "test", description: "运行测试" },
      ],
      ripplePolicy: { ...DEFAULT_RIPPLE },
      contextBudget: { ...DEFAULT_BUDGET },
    }

    const tracker = createTaskTrackerFromPacket(packet)
    const verifySteps = tracker.steps.filter(s => s.id.startsWith("verify-"))
    expect(verifySteps.length).toBe(2)
    expect(verifySteps[0]!.id).toBe("verify-typecheck")
    expect(verifySteps[1]!.id).toBe("verify-test")
  })

  test("packet-driven tracker marks scope and verification steps from tool results", () => {
    const tracker = createTaskTrackerFromPacket(buildPacketFromLine({
      title: "Update src/ok.ts and run typecheck",
      goal: "G",
      nodeId: "1",
    }))

    updateTaskTrackerAfterTools({
      tracker,
      changedFiles: ["src/ok.ts"],
      toolNames: ["write_file", "typecheck"],
      verificationResults: [{
        kind: "typecheck",
        command: "typecheck",
        passed: true,
        issues: 0,
        durationMs: 1,
        summary: "ok",
      }],
      skipLegacyStepIds: true,
    })

    expect(tracker.steps.find(step => step.id === "scope-1")?.status).toBe("done")
    expect(tracker.steps.find(step => step.id === "verify-typecheck")?.status).toBe("done")
    expect(taskTrackerComplete(tracker)).toBe(true)
  })
})

// ── Integration: createMasterPlan with per-node TaskPackets ──

describe("MasterPlan + TaskPacket integration", () => {
  test("nodes have differentiated trackers based on plan text", () => {
    const nodeTitles = [
      "1. 创建package.json、tsconfig.json、项目结构",
      "2. 创建server/index.ts、server/index.test.ts，实现API接口",
      "3. 运行typecheck、test、build验证命令，确保全部通过",
    ]

    const plan = createMasterPlan("构建博客应用", "long_task", nodeTitles)

    // Node 1: file-oriented scope
    const n1 = plan.nodes[0]!
    expect(n1.tracker.requiredFiles).toContain("package.json")
    expect(n1.tracker.requiredFiles).toContain("tsconfig.json")
    expect(n1._packet).toBeDefined()
    expect(n1._packet!.scope).toContain("package.json")

    // Node 2: different file set
    const n2 = plan.nodes[1]!
    expect(n2.tracker.requiredFiles).toContain("server/index.ts")
    expect(n2.tracker.requiredFiles).toContain("server/index.test.ts")
    // Should NOT contain node 1's files
    expect(n2.tracker.requiredFiles).not.toContain("package.json")

    // Node 3: verification-oriented
    const n3 = plan.nodes[2]!
    expect(n3.tracker.requiredVerificationKinds).toContain("typecheck")
    expect(n3.tracker.requiredVerificationKinds).toContain("test")
    expect(n3.tracker.requiredVerificationKinds).toContain("build")
    // No concrete files in this node
    expect(n3.tracker.requiredFiles).toEqual([])
  })

  test("all nodes start in building phase", () => {
    const plan = createMasterPlan("G", "long_task", ["1. A", "2. B"])

    for (const node of plan.nodes) {
      expect(node.tracker.phase).toBe("building")
    }
  })

  test("createMasterPlan attaches ContextMap evidence to every TaskPacket", () => {
    const plan = createMasterPlan(
      "G",
      "long_task",
      ["1. Update src/context/context-map.ts", "2. Run bun run typecheck"],
      {
        contextMapId: "ctx-runtime-task",
        requiredContextEvidence: [
          "locateResult:src/context/context-map.ts",
          "verification:bun run typecheck",
        ],
      },
    )

    for (const node of plan.nodes) {
      expect(node._packet?.contextMapId).toBe("ctx-runtime-task")
      expect(node._packet?.requiredContextEvidence).toContain("locateResult:src/context/context-map.ts")
    }
  })

  test("first node active, others pending", () => {
    const plan = createMasterPlan("G", "long_task", ["1. A", "2. B", "3. C"])

    expect(plan.nodes[0]!.status).toBe("active")
    expect(plan.nodes[1]!.status).toBe("pending")
    expect(plan.nodes[2]!.status).toBe("pending")
    expect(currentNode(plan)!.id).toBe("1")
  })

  test("tracker goal includes both parent goal and node title", () => {
    const plan = createMasterPlan("构建全栈博客", "long_task", ["1. 创建数据库模型"])

    const tracker = plan.nodes[0]!.tracker
    expect(tracker.goal).toContain("构建全栈博客")
    expect(tracker.goal).toContain("创建数据库模型")
  })

  test("_packet stored for serialization", () => {
    const plan = createMasterPlan("G", "long_task", ["1. 创建server/index.ts"])

    const p = plan.nodes[0]!._packet
    expect(p).toBeDefined()
    expect(p!.nodeId).toBe("1")
    expect(p!.scope).toContain("server/index.ts")
    expect(p!.ripplePolicy.autoPropagate).toBe(true)
  })

  test("addNode creates packet-backed tracker and refreshes validation", () => {
    const plan = createMasterPlan("G", "long_task", ["1. Update src/agent/task-packet.ts"])
    const node = addNode(plan, "2. Update src/context/context-map.ts and run typecheck", [], "1")

    expect(node._packet).toBeDefined()
    expect(node._packet!.nodeId).toBe("2")
    expect(node._packet!.scope).toContain("src/context/context-map.ts")
    expect(node.tracker.requiredFiles).toContain("src/context/context-map.ts")
    expect(node.tracker.requiredVerificationKinds).toContain("typecheck")
    expect(plan._lastValidation?.isClean).toBe(true)
  })

  test("revisePlan creates packet-backed replacement nodes", async () => {
    const plan = createMasterPlan("G", "long_task", ["1. Done", "2. Old remaining"])
    plan.nodes[0]!.status = "done"

    const streamChat = async function* () {
      yield {
        type: "text",
        data: JSON.stringify({
          nodes: [
            { title: "Update src/context/context-map.ts and run typecheck", dependsOn: [1] },
          ],
        }),
      }
    }

    const result = await revisePlan({
      plan,
      trigger: "plan_stale",
      streamChat,
    })

    expect(result.changed).toBe(true)
    const replacement = result.plan.nodes.find(node => node.id === "2")
    expect(replacement?._packet?.scope).toContain("src/context/context-map.ts")
    expect(replacement?.tracker.requiredFiles).toContain("src/context/context-map.ts")
    expect(result.plan._lastValidation?.isClean).toBe(true)
  })

  test("serializePlan includes packet scope, verification, context map evidence, and validation", () => {
    const plan = createMasterPlan("G", "long_task", ["1. Update src/context/context-map.ts and run typecheck"])
    const packet = plan.nodes[0]!._packet!
    packet.contextMapId = "ctx-123456789abc"
    packet.requiredContextEvidence = ["locateResult:src/context/context-map.ts"]

    const serialized = serializePlan(plan) as {
      nodes: Array<{ packet?: { contextMapId?: string; requiredContextEvidence?: string[]; scope?: string[]; verification?: unknown[] } }>
      validation?: { isClean: boolean }
    }

    expect(serialized.nodes[0]!.packet?.contextMapId).toBe("ctx-123456789abc")
    expect(serialized.nodes[0]!.packet?.requiredContextEvidence).toContain("locateResult:src/context/context-map.ts")
    expect(serialized.nodes[0]!.packet?.scope).toContain("src/context/context-map.ts")
    expect(serialized.nodes[0]!.packet?.verification?.length).toBeGreaterThan(0)
    expect(serialized.validation?.isClean).toBe(true)
  })
})
