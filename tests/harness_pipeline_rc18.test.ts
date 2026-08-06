import { describe, expect, test } from "bun:test"
import { runContextPipeline, computeCoverageGate, detectToolChainBreaks, PIPELINE_ENTRYPOINT } from "../src/harness/context/pipeline"
import { allocateContextBudget, semanticTrimContent } from "../src/harness/context/budget-allocator"
import { dedupeContributions } from "../src/harness/context/dedupe"
import { contextSliceToMessages } from "../src/harness/context/assemble"
import type {
  ContextContribution,
  ContextProvider,
  ContextRequest,
} from "../src/harness/contracts/context"

// RC-18 harness-context batch: K9, K29, K30, K31, K32, K33, K34, K52, K53.
// Golden-trace rule: every default-path (budget disabled, no budgetMode)
// assertion must hold with bytes identical to the pre-RC-18 pipeline —
// verified by harness_context_freeze.test.ts and the byte tests below.

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

function provider(id: string, layer: ContextContribution["layer"], priority: number, opts?: { content?: string; required?: boolean; cacheKey?: string; group?: string; freshness?: number }): ContextProvider {
  return {
    id,
    layer,
    priority,
    cacheable: true,
    async provide() {
      return contribution({
        providerId: id,
        layer,
        priority,
        content: opts?.content,
        required: opts?.required,
        cacheKey: opts?.cacheKey,
        group: opts?.group,
        freshness: opts?.freshness,
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

// ── K9: TOOL_CHAIN_ID_EXACT_MATCH ──

describe("K9 tool chain integrity", () => {
  test("orphan tool_result (undeclared tool_use id) is flagged as a chain break", async () => {
    const content = JSON.stringify([
      { type: "tool_result", tool_use_id: "toolu_orphan", content: "ok" },
    ])
    const breaks = detectToolChainBreaks([
      contribution({ providerId: "tail", layer: "volatile", content }),
    ])
    expect(breaks).toEqual([{ providerId: "tail", toolUseId: "toolu_orphan" }])
  })

  test("complete chain is not flagged; declared id may come from another contribution", () => {
    const chain = JSON.stringify([
      { type: "tool_use", id: "toolu_1", name: "read", input: {} },
      { type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
    ])
    const result = JSON.stringify([{ type: "tool_result", tool_use_id: "toolu_2", content: "ok" }])
    const decl = JSON.stringify([{ type: "tool_use", id: "toolu_2", name: "grep", input: {} }])
    expect(detectToolChainBreaks([
      contribution({ providerId: "a", layer: "volatile", content: chain }),
      contribution({ providerId: "b", layer: "volatile", content: result }),
      contribution({ providerId: "c", layer: "volatile", content: decl }),
    ])).toEqual([])
  })

  test("pipeline records chain breaks in the manifest instead of silently passing through", async () => {
    const content = JSON.stringify([{ type: "tool_result", tool_use_id: "toolu_x", content: "ok" }])
    const slice = await runContextPipeline({
      providers: [provider("tail", "volatile", 100, { content })],
      request: baseRequest,
    })
    expect(slice.retention.dropped.some((e) => e.reason === "chain-break" && e.detail?.includes("toolu_x"))).toBe(true)
    expect(slice.warnings.some((w) => w.includes("tool chain break"))).toBe(true)
    // Record-only: the message bytes stay untouched at this layer (hard
    // removal is agent-layer K27 territory).
    const messages = contextSliceToMessages(slice)
    expect(messages.some((m) => typeof m.content === "string" && m.content.includes("toolu_x"))).toBe(true)
  })

  test("chain adjacency is preserved by the assembler (single pass, no split/reorder)", async () => {
    const chain = JSON.stringify([
      { type: "tool_use", id: "toolu_3", name: "read", input: {} },
      { type: "tool_result", tool_use_id: "toolu_3", content: "ok" },
    ])
    const slice = await runContextPipeline({
      providers: [
        provider("plan", "plan", 10, { content: "plan text" }),
        provider("tail", "volatile", 100, { content: chain }),
      ],
      request: baseRequest,
    })
    const messages = contextSliceToMessages(slice)
    expect(messages).toHaveLength(2)
    expect(String(messages[1]!.content)).toBe(chain)
  })
})

// ── K29: PIPELINE_SINGLE_ENTRYPOINT ──

describe("K29 pipeline entrypoint", () => {
  test("slice carries the authoritative entrypoint marker and path trace", async () => {
    const slice = await runContextPipeline({
      providers: [provider("p", "plan", 10)],
      request: baseRequest,
    })
    expect(slice.entrypoint).toBe(PIPELINE_ENTRYPOINT)
    expect(slice.trace[0]).toBe("context_pipeline_entrypoint:pipeline")
  })

  test("contextSliceToMessages documents the entrypoint contract (type-level, accepts both)", async () => {
    const slice = await runContextPipeline({
      providers: [provider("p", "plan", 10, { content: "text" })],
      request: baseRequest,
    })
    expect(contextSliceToMessages(slice).map((m) => m.content)).toEqual(["text"])
    // A bare (non-pipeline) slice is still structurally accepted — the
    // optional entrypoint field keeps the type backward compatible.
    const bare = {
      contributions: [contribution({ providerId: "p", layer: "plan", content: "bare" })],
      byProvider: new Map(),
      dropped: [],
      budget: { allocatedTokens: {}, totalTokens: 0, trimmedTokens: 0 },
      cachePrefixKeys: [],
      warnings: [],
    }
    expect(contextSliceToMessages(bare).map((m) => m.content)).toEqual(["bare"])
  })
})

// ── K30: PIPELINE_BUDGET_ENABLED ──

describe("K30 budget mode contract", () => {
  test("default path is disabled, traces the reason, and keeps every contribution", async () => {
    const slice = await runContextPipeline({
      providers: [
        provider("stable", "stable", 10, { content: "s" }),
        provider("volatile", "volatile", 10, { content: "v" }),
      ],
      request: baseRequest,
    })
    expect(slice.budgetMode).toBe("disabled")
    expect(slice.trace.some((t) => t.startsWith("context_budget_disabled"))).toBe(true)
    expect(slice.contributions.map((c) => c.providerId)).toEqual(["stable", "volatile"])
    expect(slice.retention.dropped).toEqual([])
  })

  test("enabled mode allocates, trims, and emits budget events", async () => {
    // estimatedTokens defaults to content.length/3 → 300 chars ≈ 100 tokens.
    const slice = await runContextPipeline({
      providers: [
        provider("plan", "plan", 10, { content: "p".repeat(300), required: true }),
        provider("vol1", "volatile", 10, { content: "v".repeat(300) }),
        provider("vol2", "volatile", 20, { content: "w".repeat(300) }),
      ],
      request: baseRequest,
      budget: { enabled: true, maxTotalTokens: 220 },
      budgetMode: "enabled",
    })
    expect(slice.budgetMode).toBe("enabled")
    expect(slice.trace.some((t) => t.startsWith("context_budget_enabled"))).toBe(true)
    expect(slice.contributions.map((c) => c.providerId)).toContain("plan")
    expect(slice.retention.dropped.some((e) => e.category === "dropped")).toBe(true)
  })

  test("enabled mode with no caps produces bytes identical to the default path", async () => {
    const providers = [
      provider("lang", "stable", 0, { content: "lang" }),
      provider("stable", "stable", 10, { content: "s".repeat(50) }),
      provider("plan", "plan", 10, { content: "p".repeat(50) }),
      provider("vol", "volatile", 10, { content: "v".repeat(50) }),
    ]
    const request = baseRequest
    const disabled = await runContextPipeline({ providers, request })
    const enabled = await runContextPipeline({
      providers,
      request,
      budget: { enabled: true },
      budgetMode: "enabled",
    })
    expect(JSON.stringify(contextSliceToMessages(enabled))).toBe(JSON.stringify(contextSliceToMessages(disabled)))
    expect(enabled.retention.retained).toHaveLength(4)
  })

  test("explicit disabled overrides an enabled budget policy (byte-frozen)", async () => {
    const slice = await runContextPipeline({
      providers: [
        provider("vol", "volatile", 10, { content: "v".repeat(200) }),
        provider("vol2", "volatile", 20, { content: "w".repeat(200) }),
      ],
      request: baseRequest,
      budget: { enabled: true, maxTotalTokens: 100 },
      budgetMode: "disabled",
    })
    expect(slice.budgetMode).toBe("disabled")
    expect(slice.contributions).toHaveLength(2)
    expect(slice.retention.dropped).toEqual([])
  })
})

// ── K31: CONTEXT_FRESHNESS_ENFORCED ──

describe("K31 freshness and dedupe", () => {
  test("dedupe prefers the fresher duplicate on the same layer", () => {
    const result = dedupeContributions([
      contribution({ providerId: "stale", layer: "volatile", cacheKey: "same", freshness: 100 }),
      contribution({ providerId: "fresh", layer: "volatile", cacheKey: "same", freshness: 200 }),
    ])
    expect(result.kept.map((c) => c.providerId)).toEqual(["fresh"])
  })

  test("undefined freshness keeps the legacy priority/order rule", () => {
    const result = dedupeContributions([
      contribution({ providerId: "a", layer: "volatile", cacheKey: "same" }),
      contribution({ providerId: "b", layer: "volatile", cacheKey: "same" }),
    ])
    expect(result.kept.map((c) => c.providerId)).toEqual(["a"])
  })

  test("stale contributions are dropped and recorded in the manifest", async () => {
    const now = 1_000_000
    const slice = await runContextPipeline({
      providers: [
        { ...provider("old", "volatile", 10, { content: "old" }), provide: async () => contribution({ providerId: "old", layer: "volatile", content: "old", freshness: now - 1000 }) },
        { ...provider("new", "volatile", 20, { content: "new" }), provide: async () => contribution({ providerId: "new", layer: "volatile", content: "new", freshness: now - 10 }) },
      ],
      request: baseRequest,
      now,
      maxContributionAgeMs: 100,
    })
    expect(slice.contributions.map((c) => c.providerId)).toEqual(["new"])
    expect(slice.retention.dropped.some((e) => e.providerId === "old" && e.reason === "stale")).toBe(true)
  })

  test("missing freshness never crashes and keeps the contribution", async () => {
    const slice = await runContextPipeline({
      providers: [provider("no-stamp", "plan", 10, { content: "kept" })],
      request: baseRequest,
      now: 1_000_000,
      maxContributionAgeMs: 100,
    })
    expect(slice.contributions.map((c) => c.providerId)).toEqual(["no-stamp"])
    expect(slice.retention.dropped).toEqual([])
  })
})

// ── K32: REQUIRED_CONTEXT_REVALIDATED ──

describe("K32 REVALIDATE semantics", () => {
  test("stale system-required is revalidated (downgraded) and dropped", async () => {
    const now = 1_000_000
    const slice = await runContextPipeline({
      providers: [
        { ...provider("sys-req", "plan", 10, { content: "must", required: true }), provide: async () => contribution({ providerId: "sys-req", layer: "plan", content: "must", required: true, freshness: now - 1000 }) },
      ],
      request: baseRequest,
      now,
      maxContributionAgeMs: 100,
    })
    expect(slice.contributions).toHaveLength(0)
    const entry = slice.retention.dropped.find((e) => e.providerId === "sys-req")
    expect(entry?.reason).toBe("revalidate")
    expect(slice.warnings.some((w) => w.includes("sys-req"))).toBe(true)
  })

  test("user-constraint-protected required is never revalidated even when stale", async () => {
    const now = 1_000_000
    const slice = await runContextPipeline({
      providers: [
        { ...provider("plan-state", "plan", 10, { content: "goal", required: true }), provide: async () => contribution({ providerId: "plan-state", layer: "plan", content: "goal", required: true, freshness: now - 1000 }) },
      ],
      request: baseRequest, // userGoal "goal" → plan-state is the constraint carrier
      now,
      maxContributionAgeMs: 100,
    })
    expect(slice.contributions.map((c) => c.providerId)).toEqual(["plan-state"])
    expect(slice.warnings.some((w) => w.includes("coverage gate"))).toBe(true)
  })

  test("required with undefined freshness stays valid and required", async () => {
    const slice = await runContextPipeline({
      providers: [provider("plan-state", "plan", 10, { content: "goal", required: true })],
      request: baseRequest,
      now: 1_000_000,
      maxContributionAgeMs: 100,
    })
    expect(slice.contributions.map((c) => c.providerId)).toEqual(["plan-state"])
    expect(slice.warnings.some((w) => w.includes("revalidat"))).toBe(false)
  })

  test("allocator: required over budget is downgraded (REVALIDATE) when opted in", () => {
    const result = allocateContextBudget(
      [
        contribution({ providerId: "sys-req", layer: "plan", content: "x".repeat(300), required: true }),
        contribution({ providerId: "vol", layer: "volatile", content: "y".repeat(300) }),
      ],
      { enabled: true, maxTotalTokens: 50 },
      { revalidateRequired: true },
    )
    expect(result.kept.map((c) => c.providerId)).not.toContain("sys-req")
    expect(result.trimmed.some((t) => t.providerId === "sys-req" && t.revalidated === true)).toBe(true)
  })

  test("allocator: legacy default keeps required over budget (opt-in only)", () => {
    const result = allocateContextBudget(
      [contribution({ providerId: "sys-req", layer: "plan", content: "x".repeat(300), required: true })],
      { enabled: true, maxTotalTokens: 10 },
    )
    expect(result.kept.map((c) => c.providerId)).toEqual(["sys-req"])
    expect(result.warnings).toContain("budget_overrun_required")
  })

  test("allocator: gate-protected required is never downgraded over budget", () => {
    const result = allocateContextBudget(
      [contribution({ providerId: "plan-state", layer: "plan", content: "x".repeat(300), required: true })],
      { enabled: true, maxTotalTokens: 10 },
      { revalidateRequired: true, protectedProviderIds: new Set(["plan-state"]) },
    )
    expect(result.kept.map((c) => c.providerId)).toEqual(["plan-state"])
    expect(result.protectedHits).toContain("plan-state")
  })
})

// ── K33: TRIM_SEMANTIC_NOT_WHOLESALE ──

describe("K33 semantic trim before wholesale drop", () => {
  test("over-budget contributions are compressed instead of dropped when a compressor works", () => {
    const result = allocateContextBudget(
      [
        contribution({ providerId: "vol", layer: "volatile", content: "v".repeat(300) }),
        contribution({ providerId: "vol2", layer: "volatile", content: "w".repeat(300) }),
      ],
      { enabled: true, maxTotalTokens: 100 },
      { semanticTrim: (content) => (content.length > 100 ? content.slice(0, 40) : null) },
    )
    expect(result.kept).toHaveLength(2)
    expect(result.trimmed).toEqual([])
    expect(result.compressed).toHaveLength(2)
    for (const entry of result.compressed) {
      expect(entry.mode).toBe("semantic")
    }
    for (const kept of result.kept) {
      expect(kept.content.length).toBeLessThanOrEqual(40)
    }
  })

  test("wholesale drop is recorded with mode when compression is impossible", () => {
    const result = allocateContextBudget(
      [contribution({ providerId: "vol", layer: "volatile", content: "v".repeat(300) })],
      { enabled: true, maxTotalTokens: 50 },
      { semanticTrim: () => null },
    )
    expect(result.kept).toEqual([])
    expect(result.trimmed[0]?.mode).toBe("wholesale")
    expect(result.compressed).toEqual([])
  })

  test("semanticTrimContent drops blank lines, then keeps head+tail with a marker", () => {
    const withBlanks = "a\n\nb\n\n\nc"
    const compact = semanticTrimContent(withBlanks)
    expect(compact).toBe("a\nb\nc")

    const long = Array.from({ length: 100 }, (_, i) => `line-${i}`).join("\n")
    const trimmed = semanticTrimContent(long)
    expect(trimmed).not.toBeNull()
    expect(trimmed!.includes("[context-compressed:")).toBe(true)
    expect(trimmed!.startsWith("line-0")).toBe(true)
    expect(trimmed!.endsWith("line-99")).toBe(true)
    expect(trimmed!.length).toBeLessThan(long.length)
  })

  test("semanticTrimContent returns null when no reduction is possible", () => {
    expect(semanticTrimContent("short line")).toBeNull()
    expect(semanticTrimContent("\n  \n")).toBeNull()
  })

  test("pipeline enabled mode records semantic-trim entries in the manifest", async () => {
    const slice = await runContextPipeline({
      providers: [
        provider("plan", "plan", 10, { content: "p".repeat(300), required: true }),
        provider("vol", "volatile", 10, { content: "v\n\n\n".repeat(100) }),
      ],
      request: baseRequest,
      budget: { enabled: true, maxTotalTokens: 120 },
      budgetMode: "enabled",
    })
    const compressedEntry = slice.retention.compressed.find((e) => e.providerId === "vol")
    expect(compressedEntry?.reason).toBe("semantic-trim")
    expect(compressedEntry?.mode).toBe("semantic")
    // The compressed contribution is still retained (semantic, not wholesale).
    expect(slice.contributions.map((c) => c.providerId)).toContain("vol")
  })
})

// ── K34/K52: DROPPED_WARNINGS_AUTHORITATIVE + CONTEXT_RETENTION_MANIFEST ──

describe("K34/K52 retention manifest", () => {
  test("mixed operations classify every contribution with a reason", async () => {
    const now = 1_000_000
    const slice = await runContextPipeline({
      providers: [
        provider("dup-a", "stable", 10, { cacheKey: "same", content: "a" }),
        provider("dup-b", "volatile", 10, { cacheKey: "same", content: "b" }),
        { ...provider("stale", "volatile", 20, { content: "stale" }), provide: async () => contribution({ providerId: "stale", layer: "volatile", content: "stale", freshness: now - 1000 }) },
        provider("kept", "plan", 10, { content: "kept" }),
      ],
      request: baseRequest,
      now,
      maxContributionAgeMs: 100,
      budget: { enabled: true, maxTotalTokens: 10_000 },
      budgetMode: "enabled",
    })
    expect(slice.retention.retained.map((e) => e.providerId)).toEqual(["dup-a", "kept"])
    expect(slice.retention.dropped.map((e) => [e.providerId, e.reason])).toEqual([
      ["dup-b", "duplicate"],
      ["stale", "stale"],
    ])
    expect(slice.retention.archived).toEqual([])
    for (const entry of [...slice.retention.retained, ...slice.retention.dropped]) {
      expect(entry.providerId.length).toBeGreaterThan(0)
    }
  })

  test("dropped entries carry the trim mode (semantic/wholesale)", () => {
    const result = allocateContextBudget(
      [contribution({ providerId: "vol", layer: "volatile", content: "v".repeat(300) })],
      { enabled: true, maxTotalTokens: 50 },
      { semanticTrim: () => null },
    )
    expect(result.trimmed[0]?.mode).toBe("wholesale")
  })

  test("manifest warnings mirror slice warnings (authoritative record)", async () => {
    const now = 1_000_000
    const slice = await runContextPipeline({
      providers: [
        { ...provider("stale", "volatile", 20, { content: "stale" }), provide: async () => contribution({ providerId: "stale", layer: "volatile", content: "stale", freshness: now - 1000 }) },
      ],
      request: baseRequest,
      now,
      maxContributionAgeMs: 100,
    })
    expect(slice.retention.warnings).toEqual(slice.warnings)
    expect(slice.retention.warnings.some((w) => w.includes("stale"))).toBe(true)
  })
})

// ── K53: CRITICAL_FACT_COVERAGE_GATE ──

describe("K53 critical fact coverage gate", () => {
  const requestWithFacts = {
    ...baseRequest,
    planState: {
      ...baseRequest.planState,
      userGoal: "ship the feature",
      rippleObligations: [
        { targetFile: "src/a.ts", symbol: "foo", caller: { file: "src/b.ts", line: 3, text: "foo()" }, reason: "still references foo" },
      ],
    },
    researchContextContent: "## Research Evidence Context\nactive",
  } as unknown as ContextRequest

  test("protects hard constraint + obligation + evidence carriers from trimming", async () => {
    const slice = await runContextPipeline({
      providers: [
        provider("plan-state", "plan", 10, { content: "p".repeat(400), required: true }),
        provider("research", "plan", 20, { content: "r".repeat(400) }),
        provider("filler", "volatile", 10, { content: "f".repeat(400) }),
      ],
      request: requestWithFacts,
      budget: { enabled: true, maxTotalTokens: 120 },
      budgetMode: "enabled",
    })
    // Critical carriers survive the tight budget.
    expect(slice.contributions.map((c) => c.providerId)).toEqual(["plan-state", "research"])
    expect(slice.retention.coverageGate.protected).toEqual(expect.arrayContaining(["plan-state", "research"]))
    expect(slice.retention.coverageGate.uncovered).toEqual([])
    // The non-critical filler was cut instead.
    expect(slice.retention.dropped.some((e) => e.providerId === "filler")).toBe(true)
  })

  test("uncovered facts are recorded when the carrier is missing", async () => {
    const slice = await runContextPipeline({
      providers: [provider("only-volatile", "volatile", 10, { content: "v" })],
      request: requestWithFacts,
    })
    expect(slice.retention.coverageGate.uncovered).toContain("constraint:user-goal")
    expect(slice.retention.coverageGate.uncovered).toContain("obligation:src/a.ts:foo")
    expect(slice.retention.coverageGate.uncovered).toContain("evidence:research")
    expect(slice.warnings.some((w) => w.includes("coverage-gate"))).toBe(true)
  })

  test("coverage gate runs before budget and works through computeCoverageGate", async () => {
    const gate = computeCoverageGate(
      [
        contribution({ providerId: "plan-state", layer: "plan", content: "goal", required: true }),
        contribution({ providerId: "research", layer: "plan", content: "evidence" }),
      ],
      requestWithFacts,
    )
    expect(gate.facts.map((f) => f.id)).toEqual([
      "constraint:user-goal",
      "obligation:src/a.ts:foo",
      "evidence:research",
    ])
    expect([...gate.protectedProviderIds]).toEqual(["plan-state", "research"])
    expect(gate.uncovered).toEqual([])
  })

  test("empty gate no-ops without errors", async () => {
    const noFacts = {
      ...baseRequest,
      planState: { ...baseRequest.planState, userGoal: "   ", rippleObligations: [] },
      researchContextContent: null,
    } as unknown as ContextRequest
    const slice = await runContextPipeline({
      providers: [provider("p", "plan", 10, { content: "x" })],
      request: noFacts,
      budget: { enabled: true, maxTotalTokens: 1000 },
      budgetMode: "enabled",
    })
    expect(slice.retention.coverageGate.facts).toEqual([])
    expect(slice.retention.coverageGate.protected).toEqual([])
    expect(slice.retention.coverageGate.uncovered).toEqual([])
    expect(slice.warnings.some((w) => w.includes("coverage-gate"))).toBe(false)
  })

  test("gate protection intercepts allocator trim attempts", () => {
    const result = allocateContextBudget(
      [contribution({ providerId: "research", layer: "plan", content: "r".repeat(400) })],
      { enabled: true, maxTotalTokens: 50 },
      { protectedProviderIds: new Set(["research"]) },
    )
    expect(result.kept.map((c) => c.providerId)).toEqual(["research"])
    expect(result.protectedHits).toEqual(["research"])
  })

  test("waived obligations are not treated as blocking facts", async () => {
    const requestWithWaiver = {
      ...baseRequest,
      planState: {
        ...baseRequest.planState,
        userGoal: "ship",
        rippleObligations: [
          { targetFile: "src/a.ts", symbol: "foo", caller: { file: "src/b.ts", line: 3, text: "foo()" }, reason: "r", waiver: { reason: "intended", timestamp: 1 } },
        ],
      },
      researchContextContent: null,
    } as unknown as ContextRequest
    const slice = await runContextPipeline({
      providers: [provider("plan-state", "plan", 10, { content: "goal", required: true })],
      request: requestWithWaiver,
    })
    expect(slice.retention.coverageGate.facts.map((f) => f.id)).toEqual(["constraint:user-goal"])
  })
})
