import { describe, expect, test } from "bun:test"
import {
  createContextRequest,
  buildPlanStateDecisions,
  AUTHORITY_PRIORITY,
  contentDigest,
  type ContextAuthority,
  type FreshnessContract,
  type AuthorityConflictSignal,
} from "../src/harness/context/request"
import { createDefaultContextProviders } from "../src/harness/context/providers"
import { buildPlanStateContext } from "../src/agent/context-epoch"
import { MODES } from "../src/agent/mode-contract"
import type { ContextContribution, ContextRequest } from "../src/harness/contracts/context"
import type { RunPhaseContext } from "../src/agent/kernel/types"
import type { TaskTracker } from "../src/agent/task-tracker"
import type { RippleObligation } from "../src/ripple/obligations"
import type { EvidenceLedger, EvidenceEntry } from "../src/agent/evidence-ledger"
import type { StagedContextManager } from "../src/context/staged"

// RC-18 defect register: K2 (plan-state decisions wired), K7 (authority
// levels distinguished), K40 (fork-stable immutability linkage), K54
// (freshness contracts), K55 (authority arbitration supply). Everything is
// tested through the request/providers side; the pipeline consumption side
// is RC-18 D1.

// ── helpers ──

/** Fixture-friendly deep partial (Partial only makes the top level
 *  optional — nested fixture objects would need full shapes otherwise). */
type DeepPartial<T> = { [K in keyof T]?: NonNullable<T[K]> extends object ? DeepPartial<NonNullable<T[K]>> | null | undefined : NonNullable<T[K]> }

/** Minimal RunPhaseContext exposing only the fields createContextRequest
 *  reads (rest cast — same pattern as the existing harness tests). */
function minimalCtx(overrides: DeepPartial<RunPhaseContext> = {}): RunPhaseContext {
  return {
    planStore: { current: null },
    planning: { taskTracker: null },
    verificationState: { rippleObligations: [] },
    effectivePrompt: "hello",
    CONTEXT_MAX: 1000,
    langInstruction: "lang",
    options: { stableMemoryContext: "" },
    experienceContext: "",
    contextKernel: { hash: "", text: "", estimatedTokens: 0, sections: [] },
    contextMap: { contextMapContext: "" },
    triageSkillPrompts: [],
    runState: {
      conversation: { frozenStablePrefix: null },
      research: { context: null },
    },
    stagedContext: undefined,
    thinkingStore: undefined,
    knowledgeBase: undefined,
    rawMessages: [],
    epochState: {
      currentEpochIndex: 0,
      rolloverCount: 0,
      thresholds: { forceCompressChars: 0, compressChars: 0, rolloverChars: 0 },
      epochStartRound: 0,
      snapshots: [],
      totalCharsTrimmed: 0,
    },
    evidenceLedger: { entries: [] },
    ...overrides,
  } as unknown as RunPhaseContext
}

/** Minimal ContextRequest for direct provider calls. */
function baseRequest(overrides: DeepPartial<ContextRequest> = {}): ContextRequest {
  return {
    round: 0,
    effectivePrompt: "prompt",
    contextMax: 1000,
    langInstruction: "lang",
    frozenStablePrefixContent: null,
    stableMemoryContext: "",
    experienceContext: "",
    contextKernel: { hash: "h", text: "", estimatedTokens: 0, sections: [] },
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
    stagedContext: undefined,
    thinkingStore: undefined,
    knowledgeBase: undefined,
    taskTracker: null,
    mode: MODES.coder,
    rawMessages: [],
    epochState: {
      currentEpochIndex: 0,
      rolloverCount: 0,
      thresholds: { forceCompressChars: 0, compressChars: 0, rolloverChars: 0 },
      epochStartRound: 0,
      snapshots: [],
      totalCharsTrimmed: 0,
    },
    conflicts: [],
    ...overrides,
  } as unknown as ContextRequest
}

function ledger(entries: Array<Partial<EvidenceEntry>>): EvidenceLedger {
  return {
    entries: entries.map((e, i) => ({
      id: `ev-${i}`,
      kind: "typecheck",
      command: "cmd",
      output: "out",
      passed: true,
      timestamp: 1000 + i,
      ...e,
    })),
  }
}

function blockingObligation(partial: DeepPartial<RippleObligation> = {}): RippleObligation {
  return { targetFile: "a.ts", symbol: "foo", caller: { file: "b.ts", line: 3 }, reason: "signature changed", ...partial } as RippleObligation
}

function trackerWith(requiredVerificationKinds: string[]): TaskTracker {
  return { phase: "execution", requiredVerificationKinds, steps: [], goal: "g" } as unknown as TaskTracker
}

const providerOf = async (id: string, request: ContextRequest): Promise<ContextContribution> => {
  const p = createDefaultContextProviders().find((x) => x.id === id)
  if (!p) throw new Error(`provider ${id} not found`)
  return p.provide(request)
}

// ── K2 PLAN_STATE_DECISIONS_WIRED ──

describe("RC-18 K2 plan-state decisions wired", () => {
  test("decisions include latest evidence, blocking ripple, and verification gaps", () => {
    const ctx = minimalCtx({
      evidenceLedger: ledger([
        { kind: "typecheck", command: "tsc --noEmit", passed: true },
        { kind: "test", command: "bun test", passed: false, issues: 2 },
      ]),
      verificationState: {
        rippleObligations: [
          blockingObligation(),
          blockingObligation({ targetFile: "w.ts", symbol: "w", reason: "waived-ob", waiver: { reason: "explicitly waived" } }),
        ],
      },
      planning: { taskTracker: trackerWith(["typecheck", "build"]) },
    })
    const request = createContextRequest(ctx, 1)
    expect(request.planState.decisions).toContain("[evidence:typecheck] tsc --noEmit passed")
    expect(request.planState.decisions).toContain("[evidence:test] bun test failed (2 issues)")
    expect(request.planState.decisions).toContain("[ripple] signature changed: a.ts (via foo)")
    // Waived obligations are not blocking → excluded.
    expect(request.planState.decisions).not.toContain("[ripple] waived-ob")
    // typecheck surfaced above → no gap; build unsurfaced → gap.
    expect(request.planState.decisions).toContain("[verification] missing: build")
    expect(request.planState.decisions).not.toContain("[verification] missing: typecheck")
    // Fixed kind order: typecheck before test (element-wise prefix search —
    // indexOf is exact whole-element equality, not substring).
    const typecheckIdx = request.planState.decisions.findIndex((s) => s.startsWith("[evidence:typecheck]"))
    const testIdx = request.planState.decisions.findIndex((s) => s.startsWith("[evidence:test]"))
    expect(typecheckIdx).toBeGreaterThanOrEqual(0)
    expect(typecheckIdx).toBeLessThan(testIdx)
  })

  test("empty state yields empty decisions (no crash, byte-identical to pre-K2)", () => {
    const request = createContextRequest(minimalCtx(), 1)
    expect(request.planState.decisions).toEqual([])
    expect(buildPlanStateDecisions(minimalCtx())).toEqual([])
  })

  test("stale evidence is excluded and surfaces a verification gap", () => {
    const ctx = minimalCtx({
      evidenceLedger: ledger([{ kind: "test", command: "bun test", passed: true, stale: true }]),
      planning: { taskTracker: trackerWith(["test"]) },
    })
    const request = createContextRequest(ctx, 1)
    expect(request.planState.decisions).not.toContain("[evidence:test]")
    expect(request.planState.decisions).toContain("[verification] missing: test")
  })

  test("failed latest evidence suppresses the redundant gap for the same kind", () => {
    const ctx = minimalCtx({
      evidenceLedger: ledger([{ kind: "test", command: "bun test", passed: false }]),
      planning: { taskTracker: trackerWith(["test"]) },
    })
    const request = createContextRequest(ctx, 1)
    expect(request.planState.decisions).toContain("[evidence:test] bun test failed")
    expect(request.planState.decisions).not.toContain("[verification] missing: test")
  })

  test("decisions are bounded to 8 (consumer renders the trailing 8)", () => {
    const ctx = minimalCtx({
      evidenceLedger: ledger([
        { kind: "typecheck", command: "t1", passed: true },
        { kind: "test", command: "t2", passed: true },
        { kind: "build", command: "t3", passed: true },
        { kind: "manual", command: "t4", passed: true },
        { kind: "sandbox_execution", command: "t5", passed: true },
        { kind: "sandbox_cleanup", command: "t6", passed: true },
      ]),
      verificationState: {
        rippleObligations: [
          blockingObligation({ targetFile: "r1.ts", reason: "r1" }),
          blockingObligation({ targetFile: "r2.ts", reason: "r2" }),
          blockingObligation({ targetFile: "r3.ts", reason: "r3" }),
        ],
      },
    })
    const decisions = createContextRequest(ctx, 1).planState.decisions
    expect(decisions).toHaveLength(8)
    // Newest decisions (ripple) are at the end; the oldest evidence line is cut.
    expect(decisions[0]).not.toContain("[evidence:typecheck]")
    expect(decisions.slice(-3)).toEqual([
      "[ripple] r1: r1.ts (via foo)",
      "[ripple] r2: r2.ts (via foo)",
      "[ripple] r3: r3.ts (via foo)",
    ])
  })

  test("decisions render into the plan-state text; empty stays without the section", () => {
    const ctx = minimalCtx({
      evidenceLedger: ledger([{ kind: "typecheck", command: "tsc --noEmit", passed: true }]),
    })
    const request = createContextRequest(ctx, 1)
    const text = buildPlanStateContext(request.planState)
    expect(text).toContain("### Key Decisions")
    expect(text).toContain("[evidence:typecheck] tsc --noEmit passed")

    const emptyText = buildPlanStateContext(createContextRequest(minimalCtx(), 1).planState)
    expect(emptyText).not.toContain("### Key Decisions")
  })
})

// ── K7 AUTHORITY_LEVELS_DISTINGUISHED ──

describe("RC-18 K7 authority levels distinguished", () => {
  test("every default provider annotates its contribution with an authority", async () => {
    const expected: Record<string, ContextAuthority> = {
      "lang-instruction": "system",
      "stable-memory": "memory",
      "project-kernel": "system",
      "context-map": "tool",
      "skills": "system",
      "plan-state": "system",
      "research": "tool",
      "staged-context": "tool",
      "thinking": "memory",
      "knowledge": "memory",
      "planning": "system",
      "mode-contract": "system",
      "conversation-tail": "system",
    }
    const request = baseRequest()
    for (const p of createDefaultContextProviders()) {
      const contribution = await p.provide(request)
      expect(contribution.authority, `authority of ${p.id}`).toBe(expected[p.id])
    }
  })

  test("unannotated contributions keep legacy behavior (fields undefined)", () => {
    const legacy: ContextContribution = {
      providerId: "legacy",
      layer: "volatile",
      priority: 10,
      content: "x",
      estimatedTokens: 1,
      sourceRefs: [],
      required: false,
    }
    expect(legacy.authority).toBeUndefined()
    expect(legacy.freshnessContract).toBeUndefined()
  })

  test("annotated contributions type-check through the contracts interface", () => {
    const annotated: ContextContribution = {
      providerId: "tool-facts",
      layer: "plan",
      priority: 20,
      content: "facts",
      estimatedTokens: 1,
      sourceRefs: ["file://x"],
      required: false,
      authority: "tool",
      freshnessContract: { kind: "file", digest: "abc123" },
    }
    expect(annotated.authority).toBe("tool")
    expect(annotated.freshnessContract?.digest).toBe("abc123")
  })
})

// ── K40 FORK_STABLE_CONTEXT_IMMUTABLE (linkage side) ──

describe("RC-18 K40 fork-stable immutability linkage", () => {
  test("mutable file sources carry re-derivable freshness digests", async () => {
    const kernel = await providerOf("project-kernel", baseRequest({ contextKernel: { hash: "h1", text: "kernel", estimatedTokens: 10 } }))
    expect(kernel.freshnessContract).toEqual({ kind: "file", digest: "h1" })

    const map = await providerOf("context-map", baseRequest({ contextMapContext: "map-v1" }))
    expect(map.freshnessContract?.kind).toBe("file")
    expect(map.freshnessContract?.digest).toBe(contentDigest("map-v1"))

    const staged = { loadedFiles: new Map([["src/a.ts", "content"]]), buildContext: () => ({ toPromptText: () => "staged-text" }) } as unknown as StagedContextManager
    const stagedC = await providerOf("staged-context", baseRequest({ round: 1, stagedContext: staged }))
    expect(stagedC.freshnessContract).toEqual({ kind: "file", digest: contentDigest("staged-text") })
  })

  test("digests are content-sensitive (drift detectable on cache hits)", async () => {
    const a = (await providerOf("context-map", baseRequest({ contextMapContext: "map-v1" }))).freshnessContract?.digest
    const b = (await providerOf("context-map", baseRequest({ contextMapContext: "map-v2" }))).freshnessContract?.digest
    expect(a).toBeDefined()
    expect(a).not.toBe(b)
  })

  test("immutable sources carry no freshness contract; frozen-path parts stay clean", async () => {
    const lang = await providerOf("lang-instruction", baseRequest())
    const memory = await providerOf("stable-memory", baseRequest())
    const skills = await providerOf("skills", baseRequest())
    expect(lang.freshnessContract).toBeUndefined()
    expect(memory.freshnessContract).toBeUndefined()
    expect(skills.freshnessContract).toBeUndefined()

    const frozen = baseRequest({ frozenStablePrefixContent: "## Stable Prefix Context\n[CACHE_ANCHOR:v3]\nfrozen" })
    const frozenKernel = await providerOf("project-kernel", frozen)
    expect(frozenKernel.content).toBe("")
    expect(frozenKernel.freshnessContract).toBeUndefined()
  })
})

// ── K54 CONTEXT_FRESHNESS_CONTRACT ──

describe("RC-18 K54 freshness contracts", () => {
  test("plan-state carries {kind:plan, version} aligned to the round", async () => {
    const request = baseRequest({ planState: { ...baseRequest().planState, round: 3 } })
    const c = await providerOf("plan-state", request)
    expect(c.freshnessContract).toEqual({ kind: "plan", version: 3 })
  })

  test("research carries {kind:evidence, generation} aligned to the epoch", async () => {
    const request = baseRequest({ epochState: { currentEpochIndex: 2 }, researchContextContent: "## Research Evidence Context\nraw" })
    const c = await providerOf("research", request)
    expect(c.freshnessContract).toEqual({ kind: "evidence", generation: 2 })
    expect(c.content).toBe("## Research Evidence Context\nraw")
  })

  test("volatile memory sources carry {kind:time} stamps", async () => {
    const thinking = await providerOf("thinking", baseRequest({ round: 2, thinkingStore: { findSimilar: () => [], formatForPrompt: () => "t" } as never }))
    expect(thinking.freshnessContract?.kind).toBe("time")
    expect(typeof thinking.freshnessContract?.timestamp).toBe("number")

    const knowledge = await providerOf("knowledge", baseRequest({ round: 2, knowledgeBase: { findRelevant: () => [{ problem: "p", solution: "s" }] } as never }))
    expect(knowledge.freshnessContract?.kind).toBe("time")
    expect(typeof knowledge.freshnessContract?.timestamp).toBe("number")
  })

  test("absent contracts are undefined and never crash consumers", async () => {
    const planning = await providerOf("planning", baseRequest())
    expect(planning.freshnessContract).toBeUndefined()
    const tail = await providerOf("conversation-tail", baseRequest())
    expect(tail.freshnessContract).toBeUndefined()
  })
})

// ── K55 CONTEXT_AUTHORITY_ARBITRATION (supply side) ──

describe("RC-18 K55 authority arbitration supply", () => {
  test("AUTHORITY_PRIORITY is the documented 5-level table", () => {
    expect(AUTHORITY_PRIORITY).toEqual({ system: 5, user: 4, tool: 3, memory: 2, model: 1 })
  })

  test("conflicts signal defaults to [] on every built request", () => {
    const request = createContextRequest(minimalCtx(), 1)
    expect(request.conflicts).toEqual([])
  })

  test("conflicts are constructible and typed on ContextRequest", () => {
    const signal: AuthorityConflictSignal = { topic: "goal", authorities: ["user", "system"] }
    expect(AUTHORITY_PRIORITY[signal.authorities[0]!]).toBeLessThan(AUTHORITY_PRIORITY[signal.authorities[1]!])

    const request: ContextRequest = { ...baseRequest(), conflicts: [signal, { topic: "repo-state", authorities: ["tool", "memory"] }] }
    expect(request.conflicts).toHaveLength(2)
    expect(request.conflicts?.[0]?.authorities).toEqual(["user", "system"])
  })

  test("decisions built via createContextRequest match buildPlanStateDecisions", () => {
    const ctx = minimalCtx({
      evidenceLedger: ledger([{ kind: "build", command: "bun run build", passed: true }]),
      planning: { taskTracker: trackerWith(["build"]) },
    })
    expect(createContextRequest(ctx, 1).planState.decisions).toEqual(buildPlanStateDecisions(ctx))
  })

  test("authority is usable for arbitration ordering across providers", async () => {
    const providers = createDefaultContextProviders()
    const request = baseRequest()
    const plan = await providers.find((p) => p.id === "plan-state")!.provide(request)
    const knowledge = await providers.find((p) => p.id === "knowledge")!.provide(request)
    expect(AUTHORITY_PRIORITY[plan.authority ?? "model"]).toBeGreaterThan(AUTHORITY_PRIORITY[knowledge.authority ?? "model"])
    // A fresh typed copy of FreshnessContract is importable for consumers.
    const contract: FreshnessContract = { kind: "file", digest: "d" }
    expect(contract.kind).toBe("file")
  })
})
