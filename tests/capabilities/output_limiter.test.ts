import { describe, expect, test } from "bun:test"
import { createArtifactStore } from "../../src/harness/artifacts/artifact-store"
import { DEFAULT_MAX_OUTPUT_BYTES, limitOutput } from "../../src/harness/capabilities/output-limiter"
import { FIRST_BATCH_OUTPUT_SCHEMAS, GIT_STATUS_OUTPUT_SCHEMA } from "../../src/harness/capabilities/output-schemas"
import { validateJsonSchema } from "../../src/harness/capabilities/schema-validator"
import { createCapabilityRegistry } from "../../src/harness/capabilities/registry"
import { executeCapability } from "../../src/harness/capabilities/executor"
import { createCapabilityDescriptor } from "../../src/harness/capabilities/descriptor"
import { PermissionGate } from "../../src/agent/permission"
import { assembleRunScope } from "../../src/harness/runtime/run-scope"
import { createBudgetLedger, mergeRunBudget } from "../../src/harness/runtime/budget-ledger"
import { contextFromRunScope } from "../../src/harness/capabilities/execution-context"

// RT-4: output limiting — oversized results land in the artifact store and
// the caller receives a preview + artifact ref.

describe("RT-4 output limiter", () => {
  test("content under budget passes through untouched", async () => {
    const store = createArtifactStore()
    const out = await limitOutput({ content: "small", maxBytes: 100, runId: "r", producedBy: "probe", store })
    expect(out.truncated).toBe(false)
    expect(out.preview).toBe("small")
    expect(out.artifactId).toBeUndefined()
  })

  test("oversized content is truncated and stored as an artifact", async () => {
    const store = createArtifactStore()
    const big = "x".repeat(5000)
    const out = await limitOutput({ content: big, maxBytes: 100, runId: "run-12345678", producedBy: "probe", store })
    expect(out.truncated).toBe(true)
    expect(out.preview.length).toBe(100)
    expect(out.artifactId).toBeDefined()
    expect(out.contentHash).toBeDefined()

    // The artifact resolves back to the FULL content via its ref.
    const artifact = await store.get(out.artifactId!)
    expect(artifact).not.toBeNull()
    expect(artifact!.kind).toBe("tool_result")
    expect(artifact!.producedBy).toBe("probe")
    const full = await store.getContent(artifact!.contentRef)
    expect(full).toBe(big)
  })

  test("no store degrades to plain truncation, never throws", async () => {
    const out = await limitOutput({ content: "y".repeat(200), maxBytes: 100, runId: "r", producedBy: "probe" })
    expect(out.truncated).toBe(true)
    expect(out.preview.length).toBe(100)
    expect(out.artifactId).toBeUndefined()
  })

  test("default budget matches the legacy shell cap", () => {
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBe(8000)
  })
})

describe("RT-4 first-batch output schemas", () => {
  test("all five migration targets are declared", () => {
    expect(Object.keys(FIRST_BATCH_OUTPUT_SCHEMAS).sort()).toEqual(
      ["git_diff", "git_status", "lsp_diagnostics", "typecheck", "web_search"].sort(),
    )
  })

  test("git_status schema validates a porcelain-style result", () => {
    const errors = validateJsonSchema(
      { staged: ["a.ts"], unstaged: [], untracked: ["x.txt"], conflicts: [], branch: "main", dirty: true },
      GIT_STATUS_OUTPUT_SCHEMA,
    )
    expect(errors).toEqual([])
    const bad = validateJsonSchema({ staged: [] }, GIT_STATUS_OUTPUT_SCHEMA)
    expect(bad.length).toBeGreaterThan(0)
  })
})

describe("RT-4 executor output limiting (node mode)", () => {
  test("oversized handler output becomes preview + artifact in the run store", async () => {
    const scope = assembleRunScope({ runId: "run-lim", sessionId: "s", projectRoot: "/tmp", controller: new AbortController() })
    const registry = createCapabilityRegistry()
    registry.register(
      createCapabilityDescriptor({
        id: "big_out",
        kind: "tool",
        inputSchema: { type: "object", properties: {}, required: [] },
        outputSchema: { type: "object", properties: { success: { type: "boolean" }, content: { type: "string" } }, required: ["success", "content"] },
        source: "native",
        maxOutputBytes: 200,
      }),
      {
        async execute() {
          return { ok: true, output: { success: true, content: "z".repeat(2000) } }
        },
      },
    )
    const gate = new PermissionGate()
    gate.allow("big_out")
    const ctx = contextFromRunScope(scope, { budget: createBudgetLedger(mergeRunBudget({})), signal: new AbortController().signal, approvalMode: "strict" })
    const { result } = await executeCapability(registry, {
      capabilityId: "big_out",
      params: {},
      budget: createBudgetLedger(mergeRunBudget({})),
      policyContext: { permissionGate: gate, input: {} } as never,
      context: ctx,
    })
    expect(result.success).toBe(true)
    expect(result.content).toContain("output truncated")
    expect(result.content).toMatch(/artifact out_run-lim_\w+/)
    const artifacts = await scope.artifactStore.entries()
    expect(artifacts.length).toBe(1)
    expect(artifacts[0]!.kind).toBe("tool_result")
  })

  test("handler output under budget is untouched", async () => {
    const scope = assembleRunScope({ runId: "run-small", sessionId: "s", projectRoot: "/tmp", controller: new AbortController() })
    const registry = createCapabilityRegistry()
    registry.register(
      createCapabilityDescriptor({
        id: "small_out",
        kind: "tool",
        inputSchema: { type: "object", properties: {}, required: [] },
        outputSchema: { type: "object", properties: { success: { type: "boolean" }, content: { type: "string" } }, required: ["success", "content"] },
        source: "native",
      }),
      {
        async execute() {
          return { ok: true, output: { success: true, content: "tiny" } }
        },
      },
    )
    const gate = new PermissionGate()
    gate.allow("small_out")
    const ctx = contextFromRunScope(scope, { budget: createBudgetLedger(mergeRunBudget({})), signal: new AbortController().signal, approvalMode: "strict" })
    const { result } = await executeCapability(registry, {
      capabilityId: "small_out",
      params: {},
      budget: createBudgetLedger(mergeRunBudget({})),
      policyContext: { permissionGate: gate, input: {} } as never,
      context: ctx,
    })
    // Handler output is the tool's structured value; content carries its
    // JSON rendition (executor semantics, unchanged).
    expect((JSON.parse(result.content) as { content: string }).content).toBe("tiny")
    expect(await scope.artifactStore.entries()).toEqual([])
  })
})
