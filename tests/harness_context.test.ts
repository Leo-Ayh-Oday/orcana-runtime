import { describe, expect, test } from "bun:test"
import { runContextPipeline } from "../src/harness/context/pipeline"
import { dedupeContributions } from "../src/harness/context/dedupe"
import { allocateContextBudget } from "../src/harness/context/budget-allocator"
import { contextSliceToMessages, stableMessageOf } from "../src/harness/context/assemble"
import { createDefaultContextProviders } from "../src/harness/context/providers"
import { LAYER_ORDER } from "../src/harness/contracts/context"
import { buildPlanStateContext } from "../src/agent/context-epoch"
import type {
  ContextBudgetPolicy,
  ContextContribution,
  ContextProvider,
  ContextRequest,
} from "../src/harness/contracts/context"

// H10: pipeline core — ordering, budget, required retention, dedupe,
// cache keys, freshness. Byte-frozen equivalence with the loop's legacy
// assembly lives in harness_context_freeze.test.ts (phase 3).

function contribution(partial: Partial<ContextContribution> & { providerId: string; layer: ContextContribution["layer"] }): ContextContribution {
  return {
    providerId: partial.providerId,
    layer: partial.layer,
    priority: partial.priority ?? 0,
    content: partial.content ?? `content-of-${partial.providerId}`,
    estimatedTokens: partial.estimatedTokens ?? Math.ceil((partial.content ?? `content-of-${partial.providerId}`).length / 3),
    sourceRefs: partial.sourceRefs ?? [],
    cacheKey: partial.cacheKey,
    required: partial.required ?? false,
    freshness: partial.freshness,
    group: partial.group,
  }
}

function provider(id: string, layer: ContextContribution["layer"], priority: number, opts?: { cacheable?: boolean; group?: string; content?: string; required?: boolean; cacheKey?: string }): ContextProvider {
  return {
    id,
    layer,
    priority,
    cacheable: opts?.cacheable ?? true,
    async provide() {
      return contribution({
        providerId: id,
        layer,
        priority,
        content: opts?.content,
        required: opts?.required,
        cacheKey: opts?.cacheKey,
        group: opts?.group,
        sourceRefs: [id],
      })
    },
  }
}

const baseRequest = {
  round: 0,
  effectivePrompt: "prompt",
  contextMax: 1000,
  langInstruction: "lang",
  frozenStablePrefixContent: null,
  contextKernel: { hash: "h", text: "", estimatedTokens: 0 },
  contextMapContext: "",
  triageSkillPrompts: [],
  planState: {
    masterPlan: null,
    taskTracker: null,
    taskPacket: null,
    rippleObligations: [],
    userGoal: "goal",
    decisions: [],
    round: 0,
  },
  researchContextContent: null,
  taskTracker: null,
  mode: { mode: "coder" },
  rawMessages: [],
  epochState: { currentEpochIndex: 0, rolloverCount: 0 },
} as unknown as ContextRequest

describe("H10 pipeline ordering", () => {
  test("contributions sort by layer, then priority, then providerId", async () => {
    const slice = await runContextPipeline({
      providers: [
        provider("late-volatile", "volatile", 10),
        provider("early-plan", "plan", 10),
        provider("early-stable", "stable", 20),
        provider("first-stable", "stable", 10),
      ],
      request: baseRequest,
    })
    expect(slice.contributions.map((c) => c.providerId)).toEqual(["first-stable", "early-stable", "early-plan", "late-volatile"])
  })

  test("contextSliceToMessages renders groups at first-member position", async () => {
    const slice = await runContextPipeline({
      providers: [
        provider("lang", "stable", 0),
        provider("stable-a", "stable", 10, { group: "stable-prefix", content: "part-a" }),
        provider("stable-b", "stable", 20, { group: "stable-prefix", content: "part-b" }),
        provider("plan-state", "plan", 10, { content: "plan text" }),
        provider("vol-a", "volatile", 10, { group: "volatile-round", content: "vol-a" }),
        provider("vol-b", "volatile", 20, { group: "volatile-round", content: "vol-b" }),
        provider("mode", "volatile", 90, { content: "mode text" }),
      ],
      request: baseRequest,
    })
    const messages = contextSliceToMessages(slice)
    expect(messages.map((m) => m.content)).toEqual([
      "content-of-lang",
      "## Stable Prefix Context\n[CACHE_ANCHOR:v3]\n\npart-a\n\npart-b",
      "plan text",
      "## Volatile Round Context\n\nvol-a\n\nvol-b",
      "mode text",
    ])
  })

  test("empty and metadata-only contributions produce no message", async () => {
    const slice = await runContextPipeline({
      providers: [
        provider("empty", "stable", 0, { content: "" }),
        provider("meta", "volatile", 10, { content: "" }),
      ],
      request: baseRequest,
    })
    expect(contextSliceToMessages(slice)).toEqual([])
  })
})

describe("H10 budget allocation", () => {
  const fullSet = [
    contribution({ providerId: "stable-memory", layer: "stable", content: "x".repeat(300), required: true }),
    contribution({ providerId: "skills", layer: "stable", content: "x".repeat(300) }),
    contribution({ providerId: "plan-state", layer: "plan", content: "x".repeat(300), required: true }),
    contribution({ providerId: "research", layer: "plan", content: "x".repeat(300) }),
    contribution({ providerId: "staged", layer: "volatile", content: "x".repeat(300) }),
    contribution({ providerId: "mode", layer: "volatile", content: "x".repeat(300) }),
  ]

  test("disabled policy keeps everything", () => {
    const result = allocateContextBudget(fullSet, { enabled: false })
    expect(result.kept).toHaveLength(fullSet.length)
    expect(result.trimmed).toEqual([])
  })

  test("stable cap trims non-required by descending priority first", () => {
    const policy: ContextBudgetPolicy = { enabled: true, maxTokensByLayer: { stable: 120 } }
    const result = allocateContextBudget(fullSet, policy)
    const stableKept = result.kept.filter((c) => c.layer === "stable").map((c) => c.providerId)
    expect(stableKept).toContain("stable-memory") // required survives
    expect(result.trimmed.some((t) => t.providerId === "skills")).toBe(true)
  })

  test("total cap trims volatile before plan and never trims required", () => {
    const policy: ContextBudgetPolicy = { enabled: true, maxTotalTokens: 400 }
    const result = allocateContextBudget(fullSet, policy)
    expect(result.kept.map((c) => c.providerId)).toContain("plan-state") // required
    expect(result.kept.map((c) => c.providerId)).toContain("stable-memory") // required
    expect(result.kept.some((c) => c.providerId === "staged" && c.layer === "volatile")).toBe(false)
  })

  test("extreme budget keeps all required and warns on overrun", () => {
    const policy: ContextBudgetPolicy = { enabled: true, maxTotalTokens: 10 }
    const result = allocateContextBudget(fullSet, policy)
    for (const required of ["stable-memory", "plan-state"]) {
      expect(result.kept.some((c) => c.providerId === required)).toBe(true)
    }
    expect(result.warnings).toContain("budget_overrun_required")
  })
})

describe("H10 dedupe", () => {
  test("same cacheKey keeps the more stable contribution", () => {
    const result = dedupeContributions([
      contribution({ providerId: "a", layer: "stable", cacheKey: "same" }),
      contribution({ providerId: "b", layer: "volatile", cacheKey: "same" }),
    ])
    expect(result.kept.map((c) => c.providerId)).toEqual(["a"])
    expect(result.dropped[0]?.reason).toBe("duplicate")
  })

  test("overlapping sourceRefs dedupes with stability preference", () => {
    const result = dedupeContributions([
      contribution({ providerId: "a", layer: "plan", sourceRefs: ["file://x"] }),
      contribution({ providerId: "b", layer: "stable", sourceRefs: ["file://x"] }),
    ])
    expect(result.kept.map((c) => c.providerId)).toEqual(["b"])
  })
})

describe("H10 freshness", () => {
  test("stale non-required contributions are dropped, required kept with warning", async () => {
    const now = 1_000_000
    const slice = await runContextPipeline({
      providers: [
        provider("old-optional", "volatile", 10, { content: "old" }),
        provider("old-required", "plan", 10, { content: "must", required: true }),
      ],
      request: baseRequest,
      now,
      maxContributionAgeMs: 100,
    })
    // Both need a freshness stamp; providers built by provider() don't set one,
    // so nothing is stale — use the dedupe-level freshness path via pipeline:
    const freshSlice = await runContextPipeline({
      providers: [
        { ...provider("old-optional", "volatile", 10, { content: "old" }), provide: async () => contribution({ providerId: "old-optional", layer: "volatile", content: "old", freshness: now - 1000 }) },
        { ...provider("old-required", "plan", 10, { content: "must", required: true }), provide: async () => contribution({ providerId: "old-required", layer: "plan", content: "must", required: true, freshness: now - 1000 }) },
      ],
      request: baseRequest,
      now,
      maxContributionAgeMs: 100,
    })
    expect(freshSlice.contributions.map((c) => c.providerId)).toEqual(["old-required"])
    expect(freshSlice.warnings.some((w) => w.includes("old-required"))).toBe(true)
    expect(slice.contributions).toHaveLength(2) // default: nothing stale
  })
})

describe("H10 cache keys", () => {
  test("stable cacheKeys are collected in order", async () => {
    const slice = await runContextPipeline({
      providers: [
        provider("lang", "stable", 0, { cacheKey: "lang:v1" }),
        provider("kernel", "stable", 20, { cacheKey: "kernel:hash" }),
        provider("plan", "plan", 10, { cacheKey: "plan:x" }),
      ],
      request: baseRequest,
    })
    expect(slice.cachePrefixKeys).toEqual(["lang:v1", "kernel:hash"])
  })

  test("same request twice yields identical cache keys", async () => {
    const options = {
      providers: [provider("lang", "stable", 0, { cacheKey: "lang:v1" })],
      request: baseRequest,
    }
    const a = await runContextPipeline(options)
    const b = await runContextPipeline(options)
    expect(a.cachePrefixKeys).toEqual(b.cachePrefixKeys)
  })
})

describe("H10 contract", () => {
  test("LAYER_ORDER is stable→plan→node→volatile", () => {
    expect(LAYER_ORDER).toEqual(["stable", "plan", "node", "volatile"])
  })

  test("stableMessageOf finds the anchor message", async () => {
    const slice = await runContextPipeline({
      providers: [provider("stable-a", "stable", 10, { group: "stable-prefix", content: "part" })],
      request: baseRequest,
    })
    const stable = stableMessageOf(slice)
    expect(stable?.content).toContain("[CACHE_ANCHOR:v3]")
  })
})

describe("H10 default providers", () => {
  test("13 providers with the mapping-table identity", () => {
    const providers = createDefaultContextProviders()
    expect(providers).toHaveLength(13)
    expect(providers.map((p) => [p.id, p.layer, p.priority, p.cacheable])).toEqual([
      ["lang-instruction", "stable", 0, true],
      ["stable-memory", "stable", 10, true],
      ["project-kernel", "stable", 20, true],
      ["context-map", "stable", 30, true],
      ["skills", "stable", 40, true],
      ["plan-state", "plan", 10, true],
      ["research", "plan", 20, false],
      ["staged-context", "volatile", 10, false],
      ["thinking", "volatile", 20, false],
      ["knowledge", "volatile", 30, false],
      ["planning", "volatile", 40, false],
      ["mode-contract", "volatile", 90, true],
      ["conversation-tail", "volatile", 100, false],
    ])
  })

  test("plan-state provider content equals buildPlanStateContext output", async () => {
    const providers = createDefaultContextProviders()
    const request = { ...baseRequest, planState: { ...baseRequest.planState, round: 1 } } as ContextRequest
    const contribution = await providers.find((p) => p.id === "plan-state")!.provide(request)
    expect(contribution.content).toBe(buildPlanStateContext(request.planState))
    expect(contribution.required).toBe(true)
  })

  test("stable-memory round 0 composes stable memory + experience", async () => {
    const providers = createDefaultContextProviders()
    const request = {
      ...baseRequest,
      frozenStablePrefixContent: null,
      stableMemoryContext: "memory",
      experienceContext: "## Experience\nlearned",
    } as ContextRequest
    const contribution = await providers.find((p) => p.id === "stable-memory")!.provide(request)
    expect(contribution.content).toBe("## Stable Cold Memory\nmemory\n\n## Experience\nlearned")
    expect(contribution.cacheKey).toBe("stable-prefix:v3")
  })

  test("frozen prefix: stable-memory passes it through, other stable parts go empty", async () => {
    const providers = createDefaultContextProviders()
    const frozen = "## Stable Prefix Context\n[CACHE_ANCHOR:v3]\n\n## Stable Cold Memory\nfrozen"
    const request = { ...baseRequest, frozenStablePrefixContent: frozen } as ContextRequest
    const memory = await providers.find((p) => p.id === "stable-memory")!.provide(request)
    expect(memory.content).toBe(frozen)
    const kernel = await providers.find((p) => p.id === "project-kernel")!.provide(request)
    const contextMap = await providers.find((p) => p.id === "context-map")!.provide(request)
    const skills = await providers.find((p) => p.id === "skills")!.provide(request)
    expect(kernel.content).toBe("")
    expect(contextMap.content).toBe("")
    expect(skills.content).toBe("")
  })

  test("project-kernel provider wraps the kernel text header", async () => {
    const providers = createDefaultContextProviders()
    const request = { ...baseRequest, contextKernel: { hash: "h1", text: "kernel-text", estimatedTokens: 10 } } as ContextRequest
    const contribution = await providers.find((p) => p.id === "project-kernel")!.provide(request)
    expect(contribution.content).toBe("## Project Context Kernel\nkernel-text")
    expect(contribution.cacheKey).toBe("kernel:h1")
  })

  test("knowledge provider uses the inline loop format, not KnowledgeBase.buildContext", async () => {
    const providers = createDefaultContextProviders()
    const kb = {
      findRelevant: () => [{ problem: "p1", solution: "s1" }, { problem: "p2", solution: "s2" }],
    }
    const request = { ...baseRequest, round: 3, knowledgeBase: kb } as unknown as ContextRequest
    const contribution = await providers.find((p) => p.id === "knowledge")!.provide(request)
    expect(contribution.content).toBe("\n## 已学知识\n问题: p1\n方案: s1\n\n问题: p2\n方案: s2\n")
  })

  test("knowledge is empty before round 2", async () => {
    const providers = createDefaultContextProviders()
    const request = { ...baseRequest, round: 1, knowledgeBase: { findRelevant: () => [{ problem: "p", solution: "s" }] } } as unknown as ContextRequest
    const contribution = await providers.find((p) => p.id === "knowledge")!.provide(request)
    expect(contribution.content).toBe("")
  })

  test("research provider passes content through byte-for-byte", async () => {
    const providers = createDefaultContextProviders()
    const request = { ...baseRequest, researchContextContent: "## Research Evidence Context\nraw" } as ContextRequest
    const contribution = await providers.find((p) => p.id === "research")!.provide(request)
    expect(contribution.content).toBe("## Research Evidence Context\nraw")
  })

  test("conversation-tail is metadata-only with epoch facts", async () => {
    const providers = createDefaultContextProviders()
    const request = { ...baseRequest, rawMessages: [{ role: "user", content: "a" }] } as ContextRequest
    const contribution = await providers.find((p) => p.id === "conversation-tail")!.provide(request)
    expect(contribution.content).toBe("")
    expect(contribution.sourceRefs).toContain("raw:1")
  })
})
