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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBudgetLedger, defaultRunBudget } from "../src/harness/runtime/budget-ledger"
import { HarnessError } from "../src/harness/contracts/errors"
import { executeCapability } from "../src/harness/capabilities/executor"
import { buildNodePolicyInput } from "../src/harness/capabilities/policy-adapter"
import { createToolArtifactTracker } from "../src/harness/capabilities/tool-adapter"
import { createArtifactStore } from "../src/harness/artifacts/artifact-store"
import { planTextFromPayload } from "../src/harness/runtime/legacy-loop-adapter"
import { evaluateToolPolicy } from "../src/agent/tool-execution/policy"
import { PermissionGate } from "../src/agent/permission"
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

// ── Executor (part B): the 8-step chain (plan §15.3) ──

function customRegistry(execute: () => Promise<{ ok: boolean; output?: unknown; error?: string }>) {
  const registry = createCapabilityRegistry()
  registry.register(
    createCapabilityDescriptor({
      id: "custom_verifier",
      kind: "verifier",
      inputSchema: { type: "object", properties: {}, required: [] },
      sideEffect: "none",
    }),
    { execute },
  )
  return registry
}

function writeCapabilityRegistry(tools: ReturnType<typeof FIRST_BATCH>, handler: (params: Record<string, unknown>) => Promise<{ ok: boolean; output?: unknown; error?: string }>) {
  const registry = createCapabilityRegistry()
  const tool = tools.find((t) => t.defn.name === "write_file")!
  registry.register(projectCapabilityDescriptor(tool), { execute: handler })
  return { registry, tool }
}

describe("H9 capability executor", () => {
  test("node mode executes a registered capability and synthesizes a ToolResult", async () => {
    const registry = customRegistry(async () => ({ ok: true, output: { content: "verified", success: true } }))
    const { result } = await executeCapability(registry, { capabilityId: "custom_verifier", params: {} })
    expect(result.success).toBe(true)
    expect(result.content).toContain("verified")
  })

  test("handler failure surfaces as a failed ToolResult", async () => {
    const registry = customRegistry(async () => ({ ok: false, error: "boom" }))
    const { result } = await executeCapability(registry, { capabilityId: "custom_verifier", params: {} })
    expect(result.success).toBe(false)
    expect((result as { success: false; error: string }).error).toBe("boom")
  })

  test("unknown capability id is rejected", async () => {
    const registry = createCapabilityRegistry()
    await expect(executeCapability(registry, { capabilityId: "nope", params: {} })).rejects.toThrowError(HarnessError)
  })

  test("node-mode policy runs the same evaluateToolPolicy pure function", async () => {
    const tools = FIRST_BATCH()
    const tool = tools.find((t) => t.defn.name === "write_file")!
    const gate = new PermissionGate()
    gate.deny("write_file")
    const { registry } = writeCapabilityRegistry(tools, async (params) => ({ ok: true, output: params }))
    const events: unknown[] = []
    const { result } = await executeCapability(registry, {
      capabilityId: "write_file",
      params: { path: "x.ts" },
      tool,
      policyContext: { permissionGate: gate, input: { path: "x.ts" }, tool },
      emit: (type, payload) => events.push({ type, payload }),
    })
    expect(result.success).toBe(false)
    expect((result as { metadata?: { blocked?: boolean } }).metadata?.blocked).toBe(true)
    // Policy decision is byte-identical to a direct evaluateToolPolicy call.
    const direct = evaluateToolPolicy(buildNodePolicyInput({ permissionGate: gate, input: { path: "x.ts" }, tool }))
    expect(direct.allowed).toBe(false)
    if (!direct.allowed) {
      expect((result as { error: string }).error).toBe(direct.blockMessage)
    }
    expect(events.some((e) => (e as { type: string }).type === "tool.policy.blocked")).toBe(true)
  })

  test("node-mode budget: write budget exhausts with explicit reason and releases reservations", async () => {
    const registry = createCapabilityRegistry()
    registry.register(
      createCapabilityDescriptor({
        id: "write_cap",
        kind: "tool",
        inputSchema: { type: "object", properties: {}, required: [] },
        sideEffect: "write",
      }),
      { execute: async () => ({ ok: true, output: { success: true, content: "ok" } }) },
    )
    const ledger = createBudgetLedger({ ...defaultRunBudget(), maxWrites: 1, maxToolCalls: 10 })
    const first = await executeCapability(registry, { capabilityId: "write_cap", params: {}, budget: ledger })
    expect(first.result.success).toBe(true)
    expect(ledger.used.writes).toBe(1)
    const second = await executeCapability(registry, { capabilityId: "write_cap", params: {}, budget: ledger })
    expect(second.result.success).toBe(false)
    expect((second.result as { error: string }).error).toContain("write_budget")
    // The limit is really enforced: a fresh reserve still fails (used=1=max).
    expect(ledger.used.writes).toBe(1)
    expect(() => ledger.reserve({ kind: "write" })).toThrow()
  })

  test("node-mode budget: read capabilities only consume tool_call", async () => {
    const registry = createCapabilityRegistry()
    registry.register(
      createCapabilityDescriptor({
        id: "read_cap",
        kind: "tool",
        inputSchema: { type: "object", properties: {}, required: [] },
        sideEffect: "none",
      }),
      { execute: async () => ({ ok: true, output: { success: true, content: "read" } }) },
    )
    const ledger = createBudgetLedger({ ...defaultRunBudget(), maxWrites: 0, maxToolCalls: 5 })
    const { result } = await executeCapability(registry, { capabilityId: "read_cap", params: {}, budget: ledger })
    expect(result.success).toBe(true)
    expect(ledger.used.writes).toBe(0)
    expect(ledger.used.toolCalls).toBe(1)
  })

  test("before hook blocks execution and releases reservations", async () => {
    let executed = 0
    const registry = createCapabilityRegistry()
    registry.register(
      createCapabilityDescriptor({
        id: "write_cap",
        kind: "tool",
        inputSchema: { type: "object", properties: {}, required: [] },
        sideEffect: "write",
      }),
      { execute: async () => { executed += 1; return { ok: true, output: { success: true, content: "ok" } } } },
    )
    const ledger = createBudgetLedger({ ...defaultRunBudget(), maxWrites: 5 })
    const hooks = {
      runBefore: async () => ({ blocked: true, warnings: ["blocked by test"] }),
      runAfter: async () => ({ blocked: false, warnings: [] }),
    }
    const { result } = await executeCapability(registry, {
      capabilityId: "write_cap",
      params: {},
      hooks: hooks as never,
      budget: ledger,
    })
    expect(executed).toBe(0)
    expect(result.success).toBe(false)
    expect(result.content).toContain("blocked by test")
    // Nothing was consumed and the blocked reservation was released: the
    // next reserve of the same kind succeeds.
    expect(ledger.used.writes).toBe(0)
    expect(() => ledger.reserve({ kind: "write" })).not.toThrow()
  })

  test("after hook can replace the result", async () => {
    const registry = createCapabilityRegistry()
    registry.register(
      createCapabilityDescriptor({
        id: "read_cap",
        kind: "tool",
        inputSchema: { type: "object", properties: {}, required: [] },
        sideEffect: "none",
      }),
      { execute: async () => ({ ok: true, output: { success: true, content: "original" } }) },
    )
    const hooks = {
      runBefore: async () => ({ blocked: false, warnings: [] }),
      runAfter: async () => ({ blocked: false, warnings: [], replaceResult: { success: true, content: "replaced" } }),
    }
    const { result } = await executeCapability(registry, {
      capabilityId: "read_cap",
      params: {},
      hooks: hooks as never,
    })
    expect(result.success).toBe(true)
    expect(result.content).toBe("replaced")
  })

  test("parallel readonly result is reused as-is without hooks", async () => {
    const tools = FIRST_BATCH()
    const tool = tools.find((t) => t.defn.name === "read_file")!
    const registry = createCapabilityRegistry()
    let executed = 0
    registry.register(projectCapabilityDescriptor(tool), {
      execute: async () => { executed += 1; return { ok: true, output: { success: true, content: "should not run" } } },
    })
    const hooks = {
      runBefore: async () => { throw new Error("before hook must not run") },
      runAfter: async () => { throw new Error("after hook must not run") },
    }
    const { result } = await executeCapability(registry, {
      capabilityId: "read_file",
      params: { path: "x.ts" },
      tool,
      hooks: hooks as never,
      parallelResult: { content: "parallel", success: true, startedAt: 1 },
    })
    expect(executed).toBe(0)
    expect(result.success).toBe(true)
    expect(result.content).toBe("parallel")
  })

  test("loop mode passes an evaluated policyDecision through unchanged", async () => {
    const tools = FIRST_BATCH()
    const tool = tools.find((t) => t.defn.name === "read_file")!
    const registry = createCapabilityRegistry()
    registry.register(projectCapabilityDescriptor(tool), {
      execute: async () => ({ ok: true, output: { success: true, content: "read" } }),
    })
    const gate = new PermissionGate()
    gate.deny("read_file")
    // Loop mode: batch-executor already evaluated the policy — the executor
    // must NOT re-evaluate it (identity passthrough).
    const { result } = await executeCapability(registry, {
      capabilityId: "read_file",
      params: { path: "x.ts" },
      tool,
      policyDecision: { allowed: false, reason: "permission:deny", blockMessage: "denied by policy", category: "safe", incrementRateLimit: "safe", source: "policy:permission:deny", priority: 2 },
      policyContext: { permissionGate: gate, input: { path: "x.ts" }, tool },
    })
    expect(result.success).toBe(false)
    expect((result as { error: string }).error).toBe("denied by policy")
  })
})

// ── Artifact wiring (part C): plan §15.3 "Artifact / Evidence" step ──

describe("H9 artifact wiring", () => {
  test("patch artifact: committed write execution records a diff-bound patch artifact", async () => {
    const store = createArtifactStore()
    const tracker = createToolArtifactTracker({ store, runId: "run-patch" })
    const dir = mkdtempSync(join(tmpdir(), "h9-patch-"))
    const file = join(dir, "a.txt")
    writeFileSync(file, "old content\n")
    try {
      const descriptor = createCapabilityDescriptor({
        id: "write_file",
        kind: "tool",
        inputSchema: { type: "object", properties: {}, required: [] },
        sideEffect: "write",
      })
      const snapshot = await tracker.beforeExecute(descriptor, { path: file })
      expect(snapshot).toBe("old content\n")
      writeFileSync(file, "new content\n")
      await tracker.afterExecute(
        descriptor,
        { path: file },
        snapshot,
        { success: true, content: "ok", metadata: { patchTransactionId: "ptxn_1" } },
      )
      const patches = await store.findByKind("patch")
      expect(patches).toHaveLength(1)
      expect(patches[0]!.producedBy).toBe("write_file")
      expect(patches[0]!.runId).toBe("run-patch")
      const diff = await store.getContent(patches[0]!.contentRef)
      // The project's diff format is a line-stat summary (not unified diff).
      expect(diff).toContain("a.txt")
      expect(diff).toContain("@@ 统计: +1 -1")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("patch artifact: failed writes and missing transactions record nothing", async () => {
    const store = createArtifactStore()
    const tracker = createToolArtifactTracker({ store, runId: "run-patch" })
    const descriptor = createCapabilityDescriptor({
      id: "write_file",
      kind: "tool",
      inputSchema: { type: "object", properties: {}, required: [] },
      sideEffect: "write",
    })
    await tracker.afterExecute(descriptor, { path: "nope.txt" }, undefined, {
      success: false, content: "failed", error: "failed",
    })
    await tracker.afterExecute(descriptor, { path: "nope.txt" }, undefined, {
      success: true, content: "ok",
    })
    expect(await store.findByKind("patch")).toHaveLength(0)
  })

  test("plan artifact: planTextFromPayload extracts text from string/object shapes", () => {
    expect(planTextFromPayload("plain plan")).toBe("plain plan")
    expect(planTextFromPayload({ planText: "structured plan" })).toBe("structured plan")
    expect(planTextFromPayload({ text: "legacy shape" })).toBe("legacy shape")
    expect(planTextFromPayload({ opaque: { nested: true } })).toContain("opaque")
    expect(planTextFromPayload(null)).toBe("")
  })
})
