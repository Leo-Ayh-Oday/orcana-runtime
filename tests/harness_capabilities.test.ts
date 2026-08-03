import { describe, expect, test } from "bun:test"
import { buildTools } from "../src/tools/registry"
import { READ_FILE, WRITE_FILE, EDIT_FILE } from "../src/tools/file"
import { SHELL_TOOL } from "../src/tools/shell"
import { TYPECHECK_TOOL } from "../src/tools/typescript"
import { FIND_SYMBOL, FIND_REFERENCES } from "../src/tools/codegraph"
import { createCapabilityRegistry } from "../src/harness/capabilities/registry"
import { budgetKindsFor, createCapabilityDescriptor, TOOL_OUTPUT_SCHEMA } from "../src/harness/capabilities/descriptor"
import {
  FIRST_BATCH_TOOL_NAMES,
  classifyToolSideEffect,
  projectCapabilityDescriptor,
  registerToolCapabilities,
  sideEffectFromContract,
  toolCapabilityHandler,
} from "../src/harness/capabilities/tool-adapter"
import { createBudgetLedger, defaultRunBudget } from "../src/harness/runtime/budget-ledger"
import { HarnessError } from "../src/harness/contracts/errors"
import type { CapabilityDescriptor } from "../src/harness/contracts/capability"

// H9 acceptance part A: tool → capability projection is a pure function of
// the canonical ToolContract, the registry enforces unique ids, and the
// budget ledger treats write/external_action/repair as first-class kinds.

const FIRST_BATCH = () =>
  buildTools(READ_FILE, WRITE_FILE, EDIT_FILE, SHELL_TOOL, TYPECHECK_TOOL, FIND_SYMBOL, FIND_REFERENCES)

describe("H9 tool → capability projection", () => {
  test("first batch registers exactly the 7 plan §15.4 tools", () => {
    expect([...FIRST_BATCH_TOOL_NAMES].sort()).toEqual(
      ["edit_file", "find_references", "find_symbol", "read_file", "shell", "typecheck", "write_file"],
    )
  })

  test("projection table: sideEffect / riskLevel / idempotency per tool", () => {
    const tools = FIRST_BATCH()
    const projected = new Map(tools.map((t) => [t.defn.name, projectCapabilityDescriptor(t)]))

    expect(projected.get("read_file")).toMatchObject({ sideEffect: "none", riskLevel: 0, idempotent: true, retryable: true })
    expect(projected.get("write_file")).toMatchObject({ sideEffect: "write", riskLevel: 2, idempotent: false })
    expect(projected.get("edit_file")).toMatchObject({ sideEffect: "write", riskLevel: 2, idempotent: false })
    expect(projected.get("shell")).toMatchObject({ sideEffect: "external", riskLevel: 4, idempotent: false, retryable: false })
    expect(projected.get("typecheck")).toMatchObject({ sideEffect: "none", riskLevel: 0, producesEvidence: true })
    expect(projected.get("find_symbol")).toMatchObject({ sideEffect: "none", riskLevel: 0, idempotent: true })
    expect(projected.get("find_references")).toMatchObject({ sideEffect: "none", riskLevel: 0, idempotent: true })
  })

  test("projection carries concurrencyGroup and permission mirrors", () => {
    const tools = FIRST_BATCH()
    const projected = new Map(tools.map((t) => [t.defn.name, projectCapabilityDescriptor(t)]))

    expect(projected.get("read_file")?.concurrencyGroup).toBe("tool:safe")
    expect(projected.get("write_file")?.concurrencyGroup).toBe("tool:file")
    // Non-concurrency-safe tools get a per-name group.
    expect(projected.get("typecheck")?.concurrencyGroup).toBe("tool:typecheck")
    expect(projected.get("write_file")?.permissions).toContain("category:file")
    expect(projected.get("shell")?.permissions).toContain("category:shell")
  })

  test("output schema is the canonical tool result shape", () => {
    const tools = FIRST_BATCH()
    for (const tool of tools) {
      const descriptor = projectCapabilityDescriptor(tool)
      expect(descriptor.outputSchema).toBe(TOOL_OUTPUT_SCHEMA)
      expect(descriptor.inputSchema).toBeDefined()
    }
  })
})

describe("H9 side-effect classification", () => {
  test("contract side effects reduce to capability vocabulary", () => {
    expect(sideEffectFromContract({ sideEffects: ["workspace_write"] } as never)).toBe("write")
    expect(sideEffectFromContract({ sideEffects: ["shell", "external_process"] } as never)).toBe("external")
    expect(sideEffectFromContract({ sideEffects: ["network"] } as never)).toBe("external")
    expect(sideEffectFromContract({ sideEffects: ["none"] } as never)).toBe("none")
    // Shell is an external action first, even though it can also write.
    expect(sideEffectFromContract({ sideEffects: ["shell", "external_process", "workspace_write"] } as never)).toBe("external")
  })

  test("classifyToolSideEffect: registered tools win, unregistered fall back by category", () => {
    const tools = FIRST_BATCH()
    expect(classifyToolSideEffect("shell", tools)).toBe("external")
    expect(classifyToolSideEffect("write_file", tools)).toBe("write")
    expect(classifyToolSideEffect("read_file", tools)).toBe("none")
    // Unregistered: web_search is a network category tool, git_status is safe.
    expect(classifyToolSideEffect("web_search", tools)).toBe("external")
    expect(classifyToolSideEffect("git_status", tools)).toBe("none")
    // Unknown tools inherit the permission system's conservative default
    // (inferToolCategory falls back to "shell") → external.
    expect(classifyToolSideEffect("unknown_tool", [])).toBe("external")
  })
})

describe("H9 registry", () => {
  test("register + resolve + list with filters", () => {
    const registry = createCapabilityRegistry()
    registerToolCapabilities(registry, FIRST_BATCH())
    expect(registry.resolve("write_file").descriptor.sideEffect).toBe("write")
    expect(registry.resolve("typecheck").descriptor.producesEvidence).toBe(true)
    expect(registry.list().map((e) => e.descriptor.id)).toHaveLength(7)
    expect(registry.list({ sideEffect: "write" }).map((e) => e.descriptor.id).sort()).toEqual(["edit_file", "write_file"])
    expect(registry.list({ kind: "tool" }).length).toBe(7)
  })

  test("unknown capability resolves to capability_not_found", () => {
    const registry = createCapabilityRegistry()
    expect(() => registry.resolve("nope")).toThrowError(HarnessError)
    try {
      registry.resolve("nope")
      expect.unreachable()
    } catch (error) {
      expect((error as HarnessError).kind).toBe("capability_not_found")
    }
  })

  test("duplicate registration rejects with capability_already_registered", () => {
    const registry = createCapabilityRegistry()
    const tools = FIRST_BATCH()
    registerToolCapabilities(registry, tools)
    const tool = tools.find((t) => t.defn.name === "read_file")!
    expect(() => registry.register(projectCapabilityDescriptor(tool), toolCapabilityHandler(tool))).toThrowError(HarnessError)
    try {
      registry.register(projectCapabilityDescriptor(tool), toolCapabilityHandler(tool))
      expect.unreachable()
    } catch (error) {
      expect((error as HarnessError).kind).toBe("capability_already_registered")
    }
  })

  test("custom descriptors can be registered alongside tool capabilities", () => {
    const registry = createCapabilityRegistry()
    const descriptor: CapabilityDescriptor = createCapabilityDescriptor({
      id: "my_verifier",
      kind: "verifier",
      inputSchema: { type: "object", properties: {}, required: [] },
      sideEffect: "none",
    })
    registry.register(descriptor, { execute: async () => ({ ok: true, output: "verified" }) })
    expect(registry.resolve("my_verifier").descriptor.kind).toBe("verifier")
    expect(registry.list({ kind: "verifier" })).toHaveLength(1)
  })
})

describe("H9 budget kinds", () => {
  test("budgetKindsFor maps sideEffect to budget kinds", () => {
    expect(budgetKindsFor({ sideEffect: "none" })).toEqual(["tool_call"])
    expect(budgetKindsFor({ sideEffect: "read" })).toEqual(["tool_call"])
    expect(budgetKindsFor({ sideEffect: "write" })).toEqual(["tool_call", "write"])
    expect(budgetKindsFor({ sideEffect: "external" })).toEqual(["tool_call", "external_action"])
  })

  test("ledger reserves and commits repair as a first-class kind", () => {
    const ledger = createBudgetLedger({ ...defaultRunBudget(), maxRepairCycles: 2 })
    const first = ledger.reserve({ kind: "repair" })
    const second = ledger.reserve({ kind: "repair" })
    expect(() => ledger.reserve({ kind: "repair" })).toThrowError(HarnessError)
    const zeroUsage = {
      wallTimeMs: 0, modelCalls: 0, toolCalls: 0,
      inputTokens: 0, outputTokens: 0, cacheMissTokens: 0,
      writes: 0, externalActions: 0, repairCycles: 0,
    }
    ledger.commit(first.id, zeroUsage)
    ledger.commit(second.id, zeroUsage)
    expect(ledger.used.repairCycles).toBe(2)
    expect(ledger.remaining().repairCycles).toBe(0)
  })
})
