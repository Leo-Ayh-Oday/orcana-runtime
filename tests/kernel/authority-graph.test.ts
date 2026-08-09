import { describe, expect, test } from "bun:test"
import {
  AK0_GATE_NAMES,
  AUTHORITY_ASSIGNMENTS,
  AUTHORITY_EDGES,
  evaluateAuthorityConformance,
  type AuthorityAssignment,
  type AuthorityEdge,
} from "../../src/kernel/authority/graph"

describe("AK-0 authority graph", () => {
  test("the canonical graph has one owner per authority and all AK-0 gates are zero", () => {
    const report = evaluateAuthorityConformance()

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
    expect(report.forbiddenRelations).toEqual([])
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

  test("a second task or world owner fails closed", () => {
    const assignments: AuthorityAssignment[] = [
      ...AUTHORITY_ASSIGNMENTS,
      { domain: "task_completion", owner: "agent_kernel" },
      { domain: "world_state", owner: "execution_fabric" },
    ]

    const report = evaluateAuthorityConformance(assignments, AUTHORITY_EDGES)
    expect(report.gates.SECOND_TASK_AUTHORITY).toBeGreaterThan(0)
    expect(report.gates.SECOND_WORLD_AUTHORITY).toBeGreaterThan(0)
  })

  test("Tool, Execution Fabric, Driver, and LLM secret violations are detected", () => {
    const edges: AuthorityEdge[] = [
      ...AUTHORITY_EDGES,
      { source: "tool_adapter", target: "agent_world", operation: "commit_world" },
      { source: "execution_fabric", target: "graph", operation: "complete_graph" },
      { source: "driver", target: "agent_world", operation: "mutate_world" },
      { source: "llm_tool", target: "host_secret", operation: "hold_host_secret" },
    ]

    const report = evaluateAuthorityConformance(AUTHORITY_ASSIGNMENTS, edges)
    expect(report.gates.TOOL_AS_AUTHORITY).toBeGreaterThan(0)
    expect(report.gates.EXECUTION_COMPLETES_GRAPH_DIRECT).toBe(1)
    expect(report.forbiddenRelations).toEqual([
      "EXECUTION_FABRIC_COMPLETES_GRAPH",
      "DRIVER_DIRECT_WORLD_MUTATION",
      "LLM_TOOL_HOLDS_HOST_SECRET",
    ])
  })
})
