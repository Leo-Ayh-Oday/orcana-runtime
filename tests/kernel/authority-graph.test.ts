import { describe, expect, test } from "bun:test"
import {
  AK0_GATE_NAMES,
  AUTHORITY_ASSIGNMENTS,
  AUTHORITY_DOMAINS,
  AUTHORITY_EDGES,
  AUTHORITY_NODES,
  AUTHORITY_OPERATIONS,
  FORBIDDEN_AUTHORITY_RELATIONS,
  evaluateAuthorityConformance,
  type AuthorityAssignment,
  type AuthorityDomain,
  type AuthorityEdge,
} from "../../src/kernel/authority/graph"

describe("AK-0 authority graph", () => {
  test("the canonical graph has exactly one owner per domain and all AK-0 gates are zero", () => {
    const report = evaluateAuthorityConformance()

    expect(AUTHORITY_ASSIGNMENTS.map(assignment => assignment.domain)).toEqual([
      ...AUTHORITY_DOMAINS,
    ])
    for (const domain of AUTHORITY_DOMAINS) {
      expect(AUTHORITY_ASSIGNMENTS.filter(assignment => assignment.domain === domain)).toHaveLength(1)
    }
    expect(AK0_GATE_NAMES).toEqual([
      "SECOND_TASK_AUTHORITY",
      "SECOND_WORLD_AUTHORITY",
      "TOOL_AS_AUTHORITY",
      "EXECUTION_COMPLETES_GRAPH_DIRECT",
    ])
    expect(report.gates).toEqual({
      SECOND_TASK_AUTHORITY: 0,
      SECOND_WORLD_AUTHORITY: 0,
      TOOL_AS_AUTHORITY: 0,
      EXECUTION_COMPLETES_GRAPH_DIRECT: 0,
    })
    expect(report.authorityAssignmentViolations).toEqual([])
    expect(report.unexpectedEdges).toEqual([])
    expect(report.missingRequiredEdges).toEqual([])
    expect(report.forbiddenRelations).toEqual([])
  })

  test("canonical authority data is frozen at runtime", () => {
    expect(Object.isFrozen(AUTHORITY_DOMAINS)).toBe(true)
    expect(Object.isFrozen(AUTHORITY_NODES)).toBe(true)
    expect(Object.isFrozen(AUTHORITY_OPERATIONS)).toBe(true)
    expect(Object.isFrozen(AK0_GATE_NAMES)).toBe(true)
    expect(Object.isFrozen(AUTHORITY_ASSIGNMENTS)).toBe(true)
    expect(AUTHORITY_ASSIGNMENTS.every(assignment => Object.isFrozen(assignment))).toBe(true)
    expect(Object.isFrozen(AUTHORITY_EDGES)).toBe(true)
    expect(AUTHORITY_EDGES.every(edge => Object.isFrozen(edge))).toBe(true)
    expect(Object.isFrozen(FORBIDDEN_AUTHORITY_RELATIONS)).toBe(true)
    expect(FORBIDDEN_AUTHORITY_RELATIONS.every(rule => Object.isFrozen(rule))).toBe(true)
    expect(FORBIDDEN_AUTHORITY_RELATIONS.every(rule => Object.isFrozen(rule.operations))).toBe(true)
  })

  test("Graph commands Kernel and Kernel commands Execution Fabric", () => {
    expect(AUTHORITY_EDGES).toContainEqual({
      source: "graph",
      target: "agent_kernel",
      operation: "command_task",
    })
    expect(AUTHORITY_EDGES).toContainEqual({
      source: "agent_kernel",
      target: "execution_fabric",
      operation: "submit_execution",
    })
  })

  test("missing, wrong, and duplicate Task owners fail closed for every Task domain", () => {
    const taskDomains: AuthorityDomain[] = [
      "task_definition",
      "task_dependencies",
      "task_completion",
    ]

    for (const domain of taskDomains) {
      const missing = AUTHORITY_ASSIGNMENTS.filter(assignment => assignment.domain !== domain)
      const wrong: AuthorityAssignment[] = AUTHORITY_ASSIGNMENTS.map(assignment =>
        assignment.domain === domain ? { ...assignment, owner: "agent_kernel" } : assignment,
      )
      const duplicate: AuthorityAssignment[] = [
        ...AUTHORITY_ASSIGNMENTS,
        { domain, owner: "agent_kernel" },
      ]

      expect(evaluateAuthorityConformance(missing, AUTHORITY_EDGES).gates.SECOND_TASK_AUTHORITY)
        .toBeGreaterThan(0)
      expect(evaluateAuthorityConformance(wrong, AUTHORITY_EDGES).gates.SECOND_TASK_AUTHORITY)
        .toBeGreaterThan(0)
      expect(evaluateAuthorityConformance(duplicate, AUTHORITY_EDGES).gates.SECOND_TASK_AUTHORITY)
        .toBeGreaterThan(0)
    }

    const nonGraphCommand: AuthorityEdge[] = [
      ...AUTHORITY_EDGES,
      { source: "driver", target: "agent_kernel", operation: "command_task" },
    ]
    expect(
      evaluateAuthorityConformance(AUTHORITY_ASSIGNMENTS, nonGraphCommand).gates
        .SECOND_TASK_AUTHORITY,
    ).toBeGreaterThan(0)
  })

  test("every authority domain reports missing, wrong, and duplicate owners", () => {
    for (const domain of AUTHORITY_DOMAINS) {
      const missing = AUTHORITY_ASSIGNMENTS.filter(assignment => assignment.domain !== domain)
      const wrong: AuthorityAssignment[] = AUTHORITY_ASSIGNMENTS.map(assignment =>
        assignment.domain === domain ? { ...assignment, owner: "agent_kernel" } : assignment,
      )
      const duplicate: AuthorityAssignment[] = [
        ...AUTHORITY_ASSIGNMENTS,
        { domain, owner: "agent_kernel" },
      ]

      for (const assignments of [missing, wrong, duplicate]) {
        expect(evaluateAuthorityConformance(assignments, AUTHORITY_EDGES).authorityAssignmentViolations)
          .toContain(domain)
      }
    }
  })

  test("missing, wrong, and duplicate World owners fail closed", () => {
    const missing = AUTHORITY_ASSIGNMENTS.filter(assignment => assignment.domain !== "world_state")
    const wrong: AuthorityAssignment[] = AUTHORITY_ASSIGNMENTS.map(assignment =>
      assignment.domain === "world_state"
        ? { ...assignment, owner: "execution_fabric" }
        : assignment,
    )
    const duplicate: AuthorityAssignment[] = [
      ...AUTHORITY_ASSIGNMENTS,
      { domain: "world_state", owner: "execution_fabric" },
    ]

    for (const assignments of [missing, wrong, duplicate]) {
      expect(evaluateAuthorityConformance(assignments, AUTHORITY_EDGES).gates.SECOND_WORLD_AUTHORITY)
        .toBeGreaterThan(0)
    }
  })

  test("only Kernel may initiate the canonical World commit edge", () => {
    const bypasses: AuthorityEdge[] = [
      { source: "execution_fabric", target: "agent_world", operation: "commit_world" },
      { source: "driver", target: "agent_world", operation: "mutate_world" },
      { source: "remote_worker", target: "agent_world", operation: "commit_world" },
      { source: "tool_adapter", target: "agent_world", operation: "mutate_world" },
    ]

    for (const bypass of bypasses) {
      const report = evaluateAuthorityConformance(AUTHORITY_ASSIGNMENTS, [
        ...AUTHORITY_EDGES,
        bypass,
      ])
      expect(report.gates.SECOND_WORLD_AUTHORITY).toBeGreaterThan(0)
    }
  })

  test("Tool and LLM edges use an exact allowlist", () => {
    const invalidToolEdges: AuthorityEdge[] = [
      { source: "tool_adapter", target: "agent_world", operation: "commit_world" },
      { source: "tool_adapter", target: "agent_world", operation: "mutate_world" },
      { source: "tool_adapter", target: "evidence_kernel", operation: "emit_receipt" },
      { source: "tool_adapter", target: "graph", operation: "bind_completion_evidence" },
      { source: "llm_tool", target: "host_secret", operation: "hold_host_secret" },
    ]

    for (const invalidEdge of invalidToolEdges) {
      const report = evaluateAuthorityConformance(AUTHORITY_ASSIGNMENTS, [
        ...AUTHORITY_EDGES,
        invalidEdge,
      ])
      expect(report.gates.TOOL_AS_AUTHORITY).toBeGreaterThan(0)
    }

    const toolAssignment: AuthorityAssignment[] = [
      ...AUTHORITY_ASSIGNMENTS,
      { domain: "evidence_sufficiency", owner: "tool_adapter" },
    ]
    expect(evaluateAuthorityConformance(toolAssignment, AUTHORITY_EDGES).gates.TOOL_AS_AUTHORITY)
      .toBeGreaterThan(0)

    const missingToolRequest = AUTHORITY_EDGES.filter(
      edge => !(edge.source === "llm_tool" && edge.target === "tool_adapter"),
    )
    const missingReport = evaluateAuthorityConformance(AUTHORITY_ASSIGNMENTS, missingToolRequest)
    expect(missingReport.gates.TOOL_AS_AUTHORITY).toBeGreaterThan(0)
    expect(missingReport.missingRequiredEdges).toHaveLength(1)
  })

  test("Execution Fabric completion and explicit forbidden relations are detected", () => {
    const edges: AuthorityEdge[] = [
      ...AUTHORITY_EDGES,
      { source: "execution_fabric", target: "graph", operation: "complete_graph" },
      { source: "driver", target: "agent_world", operation: "mutate_world" },
      { source: "llm_tool", target: "host_secret", operation: "hold_host_secret" },
    ]

    const report = evaluateAuthorityConformance(AUTHORITY_ASSIGNMENTS, edges)
    expect(report.gates.SECOND_TASK_AUTHORITY).toBeGreaterThan(0)
    expect(report.gates.SECOND_WORLD_AUTHORITY).toBeGreaterThan(0)
    expect(report.gates.TOOL_AS_AUTHORITY).toBeGreaterThan(0)
    expect(report.gates.EXECUTION_COMPLETES_GRAPH_DIRECT).toBe(1)
    expect(report.forbiddenRelations).toEqual([
      "EXECUTION_FABRIC_COMPLETES_GRAPH",
      "DRIVER_DIRECT_WORLD_MUTATION",
      "LLM_TOOL_HOLDS_HOST_SECRET",
    ])

    expect(report.unexpectedEdges).toHaveLength(3)
  })

  test("every Execution Fabric to Graph edge fails the direct-completion gate", () => {
    const evidenceBypass: AuthorityEdge[] = [
      ...AUTHORITY_EDGES,
      {
        source: "execution_fabric",
        target: "graph",
        operation: "bind_completion_evidence",
      },
    ]

    const report = evaluateAuthorityConformance(AUTHORITY_ASSIGNMENTS, evidenceBypass)
    expect(report.gates.EXECUTION_COMPLETES_GRAPH_DIRECT).toBe(1)
    expect(report.unexpectedEdges).toHaveLength(1)
  })
})
