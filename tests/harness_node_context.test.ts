import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assembleRunScope } from "../src/harness/runtime/run-scope"
import { buildNodeContextSlice, createNodePolicyContextFromRunScope, NODE_SLICE_PROVIDER_ALLOWLIST, trimNodeSlice } from "../src/harness/nodes/context"
import { createNodeContextRequest, NODE_CONTEXT_MAX_TOKENS } from "../src/harness/context/request"
import { createDefaultContextProviders, runContextPipeline } from "../src/harness/context"
import { buildLoopOptions } from "../src/harness/runtime/legacy-loop-adapter"
import { MODES } from "../src/agent/mode-contract"
import type { AgentRunScope } from "../src/harness/contracts/run"

// H12 node context: kernel-side independent request construction, node
// provider allowlist + trimming, and mode contract enrichment (the run's
// modeStore is the authority in harness mode).

function buildScope(activeMode?: "planner" | "coder"): AgentRunScope {
  const projectRoot = mkdtempSync(join(tmpdir(), "h12-node-ctx-"))
  return assembleRunScope({
    runId: `run-${projectRoot.split("/").pop()}`,
    sessionId: "sess-node-ctx",
    projectRoot,
    controller: new AbortController(),
    activeMode,
  })
}

describe("H12 node context slice", () => {
  test("buildNodeContextSlice pipes only allowlisted providers", async () => {
    const scope = buildScope("planner")
    const slice = await buildNodeContextSlice(scope, { prompt: "verify the plan against the repo" }, 0)
    const ids = new Set(slice.contributions.map((c) => c.providerId))
    for (const id of ids) {
      expect(NODE_SLICE_PROVIDER_ALLOWLIST.has(id)).toBe(true)
    }
    // Kernel-only sources are dropped by construction: no research / staged /
    // thinking / knowledge / planning / skills contributions can reach a
    // node's visible bytes.
    for (const dropped of ["research", "staged-context", "thinking", "knowledge", "planning", "skills"]) {
      expect(ids.has(dropped)).toBe(false)
    }
    // The run's mode flows through the mode-contract provider: planner in →
    // PLANNER prompt out (not the module-level default coder).
    const modePart = slice.byProvider.get("mode-contract")
    expect(modePart).toBeDefined()
    expect(modePart!.content).toContain("当前模式: PLANNER")
    // Plan-state is required and present.
    expect(slice.byProvider.get("plan-state")).toBeDefined()
  })

  test("trimNodeSlice strips non-allowlisted contributions structurally", async () => {
    const scope = buildScope()
    const request = createNodeContextRequest(scope, { prompt: "trim me" }, 0)
    const full = await runContextPipeline({ providers: await createDefaultContextProviders(), request })
    expect(full.contributions.some((c) => c.providerId === "research")).toBe(true)
    const trimmed = trimNodeSlice(full)
    expect(trimmed.contributions.some((c) => c.providerId === "research")).toBe(false)
    for (const c of trimmed.contributions) {
      expect(NODE_SLICE_PROVIDER_ALLOWLIST.has(c.providerId)).toBe(true)
    }
    expect(trimmed.byProvider.size).toBeLessThan(full.byProvider.size)
  })
})

describe("H12 node context request", () => {
  test("createNodeContextRequest builds from the run scope, not the module state", () => {
    const scope = buildScope("planner")
    const request = createNodeContextRequest(scope, { prompt: "node prompt" }, 3)
    expect(request.mode).toBe(MODES.planner)
    expect(request.effectivePrompt).toBe("node prompt")
    expect(request.planState.round).toBe(3)
    expect(request.planState.userGoal).toBe("node prompt")
    expect(request.contextMax).toBe(NODE_CONTEXT_MAX_TOKENS)
    // Kernel-only request fields are absent — node mode has no kernel round.
    expect(request.contextKernel).toBeUndefined()
    expect(request.epochState).toBeUndefined()
    expect(request.rawMessages).toEqual([])
  })

  test("plan-state decisions reuse the K2 builder over the scope's ledger", () => {
    const scope = buildScope()
    const request = createNodeContextRequest(scope, { prompt: "p" }, 0)
    expect(request.planState.masterPlan).toBe(scope.planStore.current)
    expect(request.planState.rippleObligations).toEqual([])
    expect(request.planState.decisions).toEqual([])
  })
})

describe("H12 mode contract enrichment", () => {
  test("createNodePolicyContextFromRunScope carries the run's mode contract", () => {
    const plannerScope = buildScope("planner")
    const planner = createNodePolicyContextFromRunScope(plannerScope, { input: {} })
    expect(planner.modeContract).toBe(MODES.planner)
    expect(planner.modeContract!.mode).toBe("planner")
    const coderScope = buildScope()
    const coder = createNodePolicyContextFromRunScope(coderScope, { input: {} })
    expect(coder.modeContract!.mode).toBe("coder")
  })

  test("buildLoopOptions passes the run's mode to the kernel loop", () => {
    const scope = buildScope("planner")
    const run = { runId: "r1", sessionId: "s1", scope } as never
    const options = buildLoopOptions(run, { prompt: "p" }, { provider: undefined } as never)
    expect(options.activeMode).toBe("planner")
  })
})
