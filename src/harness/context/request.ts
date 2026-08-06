/** Kernel → harness context request bridge (H10).
 *
 *  The single file that imports kernel internals (RunPhaseContext) — the
 *  same precedent as legacy-loop-adapter importing loop types. The old
 *  in-round planStateInput construction moves here so providers read one
 *  consistent request shape.
 *
 *  RC-18 (K2/K7/K54/K55): also the home of the authority / freshness
 *  contract extensions to the pipeline contract (src/harness/contracts/
 *  context.ts — owned by the main window). The fields are declared as
 *  OPTIONAL module augmentations so every consumer (pipeline / dedupe /
 *  assemble — RC-18 D1) sees them through the original interfaces without
 *  casts, and contributions/requests built without them behave exactly as
 *  before (golden trace / byte-frozen path unaffected).
 */

import type { ContextRequest } from "../contracts/context"
import type { RunPhaseContext } from "../../agent/kernel/types"
import type { PlanStateInput } from "../../agent/context-epoch"
import type { EvidenceKind } from "../../agent/evidence-ledger"
import { latestEvidence, hasFreshPassingEvidence, requiredEvidenceKinds } from "../../agent/evidence-ledger"
import { getBlockingObligations } from "../../ripple/obligations"
import { currentNode } from "../../agent/master-plan"
import { getActiveMode } from "../../agent/mode-contract"

// ── RC-18 K7 / K55: contribution authority levels ──

/** Semantic authority of a contribution's content (K7, related E3).
 *
 *  Distinguishes system injections (harness / system-prompt material) from
 *  user hard constraints, tool facts, model memory, and model-generated
 *  text — so the pipeline can arbitrate conflicts by authority (K55) and
 *  never conflate, e.g., tool output with user instructions. `undefined`
 *  means "legacy behavior" (contribution not annotated).
 */
export type ContextAuthority = "system" | "user" | "tool" | "memory" | "model"

/** Arbitration priority per authority (K55) — higher wins on conflict.
 *  Exported for the pipeline arbitration side (RC-18 D1). */
export const AUTHORITY_PRIORITY: Readonly<Record<ContextAuthority, number>> = {
  system: 5,
  user: 4,
  tool: 3,
  memory: 2,
  model: 1,
} as const

/** Reserved conflict signal on ContextRequest (K55): two or more sources
 *  with different authorities claimed the same topic. There is currently no
 *  kernel data source that indexes content by topic, so createContextRequest
 *  always emits [] — the structure exists for the pipeline arbitration side
 *  (D1) to fill from per-provider topic claims, or for a future topic
 *  registry. It is part of the D1 consumption contract. */
export interface AuthorityConflictSignal {
  topic: string
  authorities: ContextAuthority[]
}

// ── RC-18 K54: structured freshness contracts ──

/** Structured freshness contract attached to a contribution.
 *
 *  - {kind:"file", digest}         — file-sourced content fingerprinted at
 *    contribution time (project kernel, context map, staged files). A fork
 *    or cache hit can re-derive the digest and detect drift (K40 linkage).
 *  - {kind:"plan", version}        — plan-family content versioned by round.
 *  - {kind:"evidence", generation} — evidence/research-family content
 *    versioned by epoch generation.
 *  - {kind:"time", timestamp}      — volatile, wall-clock-stamped content.
 *
 *  The legacy `freshness?: number` (timestamp) field is untouched. The
 *  structured contract is additive and optional: undefined = legacy data
 *  (no contract to validate against — consumers must not fail).
 */
export interface FreshnessContract {
  kind: "file" | "plan" | "evidence" | "time"
  digest?: string
  version?: number
  generation?: number
  timestamp?: number
}

/** Deterministic 32-bit FNV-1a fingerprint — cheap change detection (not
 *  cryptographic). Used for file-sourced freshness contracts (K54). */
export function contentDigest(content: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

/**
 * RC-18 K7/K54/K55 extensions to the H10 pipeline contract
 * (src/harness/contracts/context.ts). All fields OPTIONAL — the byte-frozen
 * path and legacy consumers are untouched.
 *
 * K40 linkage: these optional fields are the freshness side of the
 * fork/stable immutability contract — a forked stable prefix that contains
 * mutable file content (project kernel text, context map, loaded files) must
 * either carry a freshnessContract digest at fork time (so a cache hit on
 * drifted content is detectable) or exclude the mutable parts entirely. The
 * forkStableContext implementation (src/context/staged.ts — Batch C) today
 * puts loadedFiles into the stable part with no such contract; see the K40
 * finding in the RC-18 report.
 */
declare module "../contracts/context" {
  interface ContextContribution {
    /** K7: semantic authority of the content; undefined = legacy behavior. */
    authority?: ContextAuthority
    /** K54: structured freshness contract; undefined = legacy data. */
    freshnessContract?: FreshnessContract
  }
  interface ContextRequest {
    /** K55: authority conflict signals (reserved; [] today). */
    conflicts?: AuthorityConflictSignal[]
  }
}

// ── RC-18 K2: plan-state decisions ──

const EVIDENCE_KINDS: EvidenceKind[] = ["typecheck", "test", "build", "manual", "sandbox_execution", "sandbox_cleanup"]

/** Decisions surfaced under the plan-state "Key Decisions" section.
 *
 *  Sources (all read-only):
 *  - evidence: the latest non-stale entry per kind — the state the
 *    completion gate would evaluate (L1 semantics; stale entries excluded).
 *  - ripple: only obligations that still block completion (non-waived).
 *  - verification: required kinds with no fresh passing evidence and no
 *    surfaced evidence line above (avoids "failed" + "missing" noise).
 *
 *  Bounded to 8 — buildPlanStateContext renders the trailing 8 entries.
 *  Empty ledger / no obligations / no required kinds → [] (byte-identical
 *  to the pre-K2 output, golden trace safe).
 */
export function buildPlanStateDecisions(ctx: RunPhaseContext): string[] {
  const entries = ctx.evidenceLedger?.entries ?? []
  const ledger = { entries }
  const decisions: string[] = []
  const surfaced = new Set<EvidenceKind>()

  // Evidence — latest non-stale entry per kind, fixed kind order (typecheck
  // first) for stable output across runs.
  for (const kind of EVIDENCE_KINDS) {
    const entry = latestEvidence(ledger, kind)
    if (!entry || entry.stale) continue
    surfaced.add(kind)
    const cmd = entry.command ?? entry.id
    const verdict = entry.passed
      ? "passed"
      : entry.issues !== undefined
        ? `failed (${entry.issues} issues)`
        : "failed"
    decisions.push(`[evidence:${kind}] ${cmd} ${verdict}`)
  }

  // Ripple — only obligations that still block completion (non-waived).
  for (const ob of getBlockingObligations(ctx.verificationState.rippleObligations)) {
    decisions.push(`[ripple] ${ob.reason}: ${ob.targetFile} (via ${ob.symbol})`)
  }

  // Verification — required kinds with no fresh passing evidence and no
  // surfaced evidence line above (avoid "failed" + "missing" redundancy).
  for (const kind of requiredEvidenceKinds(ctx.planning.taskTracker)) {
    if (!surfaced.has(kind) && !hasFreshPassingEvidence(ledger, kind)) {
      decisions.push(`[verification] missing: ${kind}`)
    }
  }

  return decisions.slice(-8)
}

/** Build the context request for one round from the kernel run context. */
export function createContextRequest(ctx: RunPhaseContext, round: number): ContextRequest {
  const planStateInput: PlanStateInput = {
    masterPlan: ctx.planStore.current,
    taskTracker: ctx.planning.taskTracker,
    taskPacket: ctx.planStore.current
      ? (currentNode(ctx.planStore.current)?._packet ?? null)
      : null,
    rippleObligations: ctx.verificationState.rippleObligations,
    userGoal: ctx.planStore.current?.goal ?? ctx.planning.taskTracker?.goal ?? ctx.effectivePrompt.slice(0, 200),
    // RC-18 K2: wired from the kernel's evidence ledger + ripple obligations
    // + task requirements (was a TODO). Empty when nothing to report.
    decisions: buildPlanStateDecisions(ctx),
    round,
  }

  const frozen = ctx.runState.conversation.frozenStablePrefix
  const researchMessage = ctx.runState.research.context
  return {
    round,
    effectivePrompt: ctx.effectivePrompt,
    contextMax: ctx.CONTEXT_MAX,
    langInstruction: ctx.langInstruction,
    frozenStablePrefixContent: frozen && typeof frozen.content === "string" ? frozen.content : null,
    stableMemoryContext: ctx.options.stableMemoryContext,
    experienceContext: ctx.experienceContext,
    contextKernel: ctx.contextKernel,
    contextMapContext: ctx.contextMap.contextMapContext,
    triageSkillPrompts: ctx.triageSkillPrompts,
    planState: planStateInput,
    // Research evidence is always built with string content; the non-string
    // branch is defensive only and never reached on the frozen path.
    researchContextContent: researchMessage
      ? typeof researchMessage.content === "string"
        ? researchMessage.content
        : JSON.stringify(researchMessage.content)
      : null,
    stagedContext: ctx.stagedContext,
    thinkingStore: ctx.thinkingStore,
    knowledgeBase: ctx.knowledgeBase,
    taskTracker: ctx.planning.taskTracker,
    mode: getActiveMode(),
    rawMessages: ctx.rawMessages,
    epochState: ctx.epochState,
    // RC-18 K55: reserved conflict signal — no topic registry exists yet.
    conflicts: [],
  }
}
