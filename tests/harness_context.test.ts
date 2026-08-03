import { describe, expect, test } from "bun:test"
import { runContextPipeline } from "../src/harness/context/pipeline"
import { dedupeContributions } from "../src/harness/context/dedupe"
import { allocateContextBudget } from "../src/harness/context/budget-allocator"
import { contextSliceToMessages, stableMessageOf } from "../src/harness/context/assemble"
import { LAYER_ORDER } from "../src/harness/contracts/context"
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
  planState: { userGoal: "goal" },
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
