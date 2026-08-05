/** G2 acceptance: validation rejects cycles, unknown handlers, write side effects. */

import { describe, expect, test } from "bun:test"
import { validateSpec } from "../../src/workflow/validation"
import type { WorkflowSpec } from "../../src/workflow/types"

const CTX: import("../../src/workflow/validation").ValidationContext = {
  knownHandlers: new Set(["tool.read_file", "tool.git_status", "tool.apply_patch"]),
  readonlyHandlers: new Set(["tool.read_file", "tool.git_status"]),
  handlerInputKind: { "tool.read_file": "object" as const, "tool.git_status": "object" as const },
}

function spec(nodes: Array<{ id: string; handler: string; input?: unknown; dependsOn?: string[] }>): WorkflowSpec {
  return {
    schemaVersion: "0.1",
    specId: "v-test",
    nodes: nodes.map(n => ({ id: n.id, handler: n.handler, input: (n.input ?? {}) as Record<string, unknown>, dependsOn: n.dependsOn ?? [] })),
  }
}

describe("G2 validation", () => {
  test("valid read-only spec passes", () => {
    const report = validateSpec(spec([{ id: "a", handler: "tool.read_file", input: { path: "/tmp" } }]), CTX)
    expect(report.ok).toBe(true)
  })

  test("cycle is rejected", () => {
    const report = validateSpec(spec([
      { id: "a", handler: "tool.read_file", dependsOn: ["b"] },
      { id: "b", handler: "tool.read_file", dependsOn: ["a"] },
    ]), CTX)
    expect(report.ok).toBe(false)
    expect(report.issues.some(i => i.code === "cycle")).toBe(true)
  })

  test("unknown dependency is rejected", () => {
    const report = validateSpec(spec([{ id: "a", handler: "tool.read_file", dependsOn: ["ghost"] }]), CTX)
    expect(report.issues.some(i => i.code === "unknown_dependency")).toBe(true)
  })

  test("unknown handler is rejected", () => {
    const report = validateSpec(spec([{ id: "a", handler: "tool.no_such_tool" }]), CTX)
    expect(report.issues.some(i => i.code === "unknown_handler")).toBe(true)
  })

  test("write handler in read-only mode is rejected (capability + side-effect)", () => {
    const report = validateSpec(spec([{ id: "a", handler: "tool.apply_patch" }]), CTX)
    expect(report.issues.some(i => i.code === "write_handler")).toBe(true)
    expect(report.issues.some(i => i.code === "write_node_in_readonly_spec")).toBe(true)
  })

  test("budget: node count cap and invalid maxParallel", () => {
    const tooMany = Array.from({ length: 250 }, (_, i) => ({ id: `n${i}`, handler: "tool.read_file" }))
    const report = validateSpec(spec(tooMany), CTX)
    expect(report.issues.some(i => i.code === "too_many_nodes")).toBe(true)

    const badParallel = validateSpec({ ...spec([{ id: "a", handler: "tool.read_file" }]), maxParallel: 0 }, CTX)
    expect(badParallel.issues.some(i => i.code === "invalid_parallel")).toBe(true)
  })

  test("schema: non-object input for an object handler is rejected", () => {
    const report = validateSpec(spec([{ id: "a", handler: "tool.read_file", input: "not-an-object" }]), CTX)
    expect(report.issues.some(i => i.code === "invalid_input")).toBe(true)
  })

  test("empty spec is rejected", () => {
    const report = validateSpec(spec([]), CTX)
    expect(report.issues.some(i => i.code === "empty_spec")).toBe(true)
  })
})
