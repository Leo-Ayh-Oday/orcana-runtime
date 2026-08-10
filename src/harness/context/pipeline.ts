/** Context Pipeline orchestrator (H10, plan §16.3) — RC-18 K-series fixes.
 *
 *  Collect → dedupe → tool-chain integrity (K9) → coverage gate (K53) →
 *  freshness (K31/K32) → sort by layer → budget (K30) → trim (K33) →
 *  ContextSlice + retention manifest (K34/K52).
 *
 *  Entrypoint (K29): runContextPipeline is the authoritative producer of
 *  ContextSlice — every returned slice carries `entrypoint: "pipeline"` and a
 *  `trace` proving the path; contextSliceToMessages only accepts pipeline
 *  slices (asserting entrypoint when present). Any future direct-message
 *  assembly path must go through this pipeline to stay auditable.
 *
 *  Budget contract (K30): budget is disabled by default — the current loop
 *  has no context trimming and enabling it changes the model-visible bytes
 *  (§3.5, a separate decision with its own Golden Trace update). The caller
 *  opts in with `budgetMode: "enabled"`; the disabled path emits an explicit
 *  `context_budget_disabled` trace so the decision is auditable instead of
 *  implicit. When budgetMode is absent, behavior is byte-identical to the
 *  pre-RC-18 pipeline.
 */

import type {
  ContextContribution,
  ContextPipelineOptions,
  ContextRequest,
  ContextSlice,
} from "../contracts/context"
import { LAYER_ORDER } from "../contracts/context"
import { getBlockingObligations } from "../../ripple/obligations"
import { dedupeContributions } from "./dedupe"
import { allocateContextBudget, semanticTrimContent } from "./budget-allocator"
import type { TrimRecord } from "./budget-allocator"

// ── K29: authoritative pipeline entrypoint ──
export const PIPELINE_ENTRYPOINT = "pipeline" as const

// ── K30: explicit budget contract ──
export type BudgetMode = "disabled" | "enabled"

// ── K34/K52: retention manifest ──
export type RetentionCategory = "retained" | "compressed" | "archived" | "dropped"
export type RetentionReason =
  | "duplicate"
  | "stale"
  | "budget"
  | "revalidate"
  | "chain-break"
  | "semantic-trim"
  | "wholesale-drop"
  | "retained"

export interface RetentionEntry {
  providerId: string
  category: RetentionCategory
  reason: RetentionReason
  detail?: string
  /** K33: how the contribution was handled when cut. */
  mode?: "semantic" | "wholesale"
}

/** K53: one critical fact the coverage gate must keep visible. */
export interface CoverageFact {
  id: string
  kind: "constraint" | "obligation" | "evidence"
  source: string
  /** providerId expected to carry this fact (may be absent from the input). */
  coveringProviderId?: string
}

export interface CoverageGateResult {
  facts: CoverageFact[]
  /** providerIds that must survive trimming (K53 protection). */
  protectedProviderIds: ReadonlySet<string>
  /** facts whose carrier is absent from the input contributions. */
  uncovered: CoverageFact[]
}

export interface RetentionManifest {
  retained: RetentionEntry[]
  compressed: RetentionEntry[]
  /** Empty until archive wiring lands (epoch H12) — reserved category. */
  archived: RetentionEntry[]
  dropped: RetentionEntry[]
  coverageGate: {
    facts: CoverageFact[]
    /** providerIds protected from trimming this round. */
    protected: string[]
    /** trim attempts the gate actually blocked. */
    intercepted: string[]
    /** facts not covered in the final slice. */
    uncovered: string[]
  }
  warnings: string[]
}

export interface PipelineMeta {
  entrypoint: "pipeline"
  budgetMode: BudgetMode
  retention: RetentionManifest
  /** Auditable path trace: entrypoint + budget decision + gate summary. */
  trace: string[]
}

export interface ContextPipelineOptionsExtra {
  /** K30: explicit budget contract. Default "disabled" (byte-frozen path). */
  budgetMode?: BudgetMode
  /** K33: override the built-in semantic compressor used in enabled mode. */
  semanticTrim?: (content: string, providerId: string) => string | null
}

// ── K9: tool chain integrity ──
// The pipeline itself has no chain-building logic (that lives in the agent
// layer, fixed by K27). At this layer we add the completeness check: a
// tool_result referencing a tool_use that was never declared in this round's
// contributions is a chain break — recorded in the manifest as dropped
// (reason "chain-break") instead of being silently passed through. Message
// bytes are untouched (the agent layer owns hard removal).
const TOOL_USE_RESULT_JSON_RE = /"type"\s*:\s*"tool_result"[\s\S]{0,300}?"tool_use_id"\s*:\s*"([^"]+)"/g
const TOOL_USE_DECL_JSON_RE = /"type"\s*:\s*"tool_use"[\s\S]{0,300}?"id"\s*:\s*"([^"]+)"/g
const TOOL_USE_RESULT_XML_RE = /<tool_result[^>]*tool_use_id\s*=\s*"([^"]+)"/g
const TOOL_USE_DECL_XML_RE = /<tool_use[^>]*id\s*=\s*"([^"]+)"/g

export interface ToolChainBreak {
  providerId: string
  toolUseId: string
}

function collectIds(re: RegExp, content: string): string[] {
  const ids: string[] = []
  re.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(content)) !== null) ids.push(match[1]!)
  return ids
}

/** K9: find tool_result blocks whose tool_use_id has no matching tool_use
 *  declaration anywhere in the round's contributions. */
export function detectToolChainBreaks(contributions: readonly ContextContribution[]): ToolChainBreak[] {
  const declared = new Set<string>()
  for (const contribution of contributions) {
    for (const id of collectIds(TOOL_USE_DECL_JSON_RE, contribution.content)) declared.add(id)
    for (const id of collectIds(TOOL_USE_DECL_XML_RE, contribution.content)) declared.add(id)
  }
  const breaks: ToolChainBreak[] = []
  for (const contribution of contributions) {
    for (const id of collectIds(TOOL_USE_RESULT_JSON_RE, contribution.content)) {
      if (!declared.has(id)) breaks.push({ providerId: contribution.providerId, toolUseId: id })
    }
    for (const id of collectIds(TOOL_USE_RESULT_XML_RE, contribution.content)) {
      if (!declared.has(id)) breaks.push({ providerId: contribution.providerId, toolUseId: id })
    }
  }
  return breaks
}

// ── K53: critical fact coverage gate ──
// Facts come from the request: user goal + required files (user hard
// constraints), blocking ripple obligations (未决义务), and active research
// evidence. Carriers are the contributions that render them — plan-state
// (goal/required-files/obligations) and research (evidence). The gate runs
// BEFORE budget trimming so protected carriers survive; coverage is
// re-verified against the final slice.
export function computeCoverageGate(
  contributions: readonly ContextContribution[],
  request: ContextRequest,
): CoverageGateResult {
  const facts: CoverageFact[] = []
  const uncovered: CoverageFact[] = []
  const protect = new Set<string>()
  const present = new Set(contributions.map((c) => c.providerId))

  const addFact = (fact: CoverageFact) => {
    facts.push(fact)
    if (fact.coveringProviderId) {
      if (present.has(fact.coveringProviderId)) protect.add(fact.coveringProviderId)
      else uncovered.push(fact)
    }
  }

  const goal = request.planState?.userGoal?.trim()
  if (goal) addFact({ id: "constraint:user-goal", kind: "constraint", source: `user goal: ${goal.slice(0, 80)}`, coveringProviderId: "plan-state" })

  for (const file of request.planState?.taskTracker?.requiredFiles ?? []) {
    addFact({ id: `constraint:required-file:${file}`, kind: "constraint", source: `required file: ${file}`, coveringProviderId: "plan-state" })
  }

  for (const obligation of getBlockingObligations(request.planState?.rippleObligations ?? [])) {
    addFact({ id: `obligation:${obligation.targetFile}:${obligation.symbol}`, kind: "obligation", source: obligation.reason, coveringProviderId: "plan-state" })
  }

  if (request.researchContextContent?.trim()) {
    addFact({ id: "evidence:research", kind: "evidence", source: "active research evidence", coveringProviderId: "research" })
  }

  return { facts, protectedProviderIds: protect, uncovered }
}

/** K53: re-verify coverage against the FINAL slice (post freshness/budget). */
export function verifyCoverageGate(gate: CoverageGateResult, kept: readonly ContextContribution[]): CoverageFact[] {
  const present = new Set(kept.map((c) => c.providerId))
  const missing: CoverageFact[] = []
  for (const fact of gate.facts) {
    if (fact.coveringProviderId && !present.has(fact.coveringProviderId)) missing.push(fact)
  }
  return missing
}

export async function runContextPipeline(
  options: ContextPipelineOptions & ContextPipelineOptionsExtra,
): Promise<ContextSlice & PipelineMeta> {
  const now = options.now ?? Date.now()
  const maxAge = options.maxContributionAgeMs ?? Number.POSITIVE_INFINITY
  // K30: explicit contract; default stays disabled (byte-frozen path).
  const budgetMode: BudgetMode = options.budgetMode ?? (options.budget?.enabled ? "enabled" : "disabled")

  // ── Step 1: collect (registration order preserved) ──
  const collected = await Promise.all(
    options.providers.map((provider) => provider.provide(options.request)),
  )

  // ── Step 2: dedupe ──
  const { kept: deduped, dropped: dedupeDropped } = dedupeContributions(collected)
  const dropped: TrimRecord[] = [...dedupeDropped]
  const retentionDropped: RetentionEntry[] = dedupeDropped.map((d) => ({
    providerId: d.providerId,
    category: "dropped",
    reason: "duplicate",
    detail: d.detail,
  }))
  const warnings: string[] = []

  // ── K9: tool chain integrity (record, never silent) ──
  for (const break_ of detectToolChainBreaks(deduped)) {
    retentionDropped.push({
      providerId: break_.providerId,
      category: "dropped",
      reason: "chain-break",
      detail: `tool_result references undeclared tool_use id ${break_.toolUseId}`,
    })
    warnings.push(`tool chain break: ${break_.providerId} references undeclared tool_use ${break_.toolUseId}`)
  }

  // ── K53: coverage gate (before freshness/budget so protection applies) ──
  const gate = computeCoverageGate(deduped, options.request)

  // ── Step 3: freshness (K31) with K32 REVALIDATE semantics ──
  const fresh: ContextContribution[] = []
  for (const contribution of deduped) {
    const isStale = contribution.freshness !== undefined && now - contribution.freshness > maxAge
    if (isStale) {
      if (contribution.required) {
        if (gate.protectedProviderIds.has(contribution.providerId)) {
          // User hard constraints (K1) are never revalidated away.
          warnings.push(`required contribution ${contribution.providerId} is stale but kept (coverage gate)`)
          fresh.push(contribution)
          continue
        }
        // K32: REVALIDATE — downgrade to optional, then stale-dropped.
        retentionDropped.push({
          providerId: contribution.providerId,
          category: "dropped",
          reason: "revalidate",
          detail: "required contribution stale — downgraded to optional and dropped (REVALIDATE)",
        })
        dropped.push({
          providerId: contribution.providerId,
          reason: "stale",
          detail: `revalidate: required contribution ${contribution.providerId} is stale`,
        })
        warnings.push(`required contribution ${contribution.providerId} is stale — revalidated and dropped`)
        continue
      }
      retentionDropped.push({ providerId: contribution.providerId, category: "dropped", reason: "stale" })
      dropped.push({ providerId: contribution.providerId, reason: "stale" })
      warnings.push(`pipeline dropped contribution ${contribution.providerId}: stale`)
      continue
    }
    fresh.push(contribution)
  }

  // ── Step 4: sort by layer, then priority, then providerId ──
  const sorted = [...fresh].sort((a, b) => {
    const byLayer = LAYER_ORDER.indexOf(a.layer) - LAYER_ORDER.indexOf(b.layer)
    if (byLayer !== 0) return byLayer
    if (a.priority !== b.priority) return a.priority - b.priority
    return a.providerId.localeCompare(b.providerId)
  })

  // ── Steps 5-6: budget allocation + trim (K30/K32/K33) ──
  const trace: string[] = [`context_pipeline_entrypoint:${PIPELINE_ENTRYPOINT}`]
  let allocation: ReturnType<typeof allocateContextBudget>
  if (budgetMode === "enabled" && options.budget) {
    allocation = allocateContextBudget(sorted, options.budget, {
      protectedProviderIds: gate.protectedProviderIds,
      revalidateRequired: true,
      semanticTrim: options.semanticTrim ?? semanticTrimContent,
    })
    trace.push(
      `context_budget_enabled:maxTotal=${options.budget.maxTotalTokens ?? "none"},kept=${allocation.kept.length},trimmed=${allocation.trimmed.length},compressed=${allocation.compressed.length}`,
    )
  } else {
    // Byte-frozen path: disabled budget keeps every contribution. The trace
    // makes the decision auditable instead of implicit (K30).
    allocation = allocateContextBudget(sorted, { enabled: false })
    trace.push(
      "context_budget_disabled:budget trimming is off by default — enabling it changes the model-visible bytes (§3.5), opt in via budgetMode:\"enabled\"",
    )
  }
  for (const trim of allocation.trimmed) dropped.push(trim)
  for (const warning of allocation.warnings) warnings.push(warning)

  // ── K53: verify coverage on the FINAL slice ──
  const uncovered = verifyCoverageGate(gate, allocation.kept)
  for (const fact of uncovered) {
    warnings.push(`coverage-gate: ${fact.kind} fact ${fact.id} not covered in final slice`)
  }
  if (uncovered.length > 0) trace.push(`context_coverage_gate:${uncovered.length} uncovered`)

  // ── Step 7: ContextSlice + retention manifest (K34/K52) ──
  const byProvider = new Map<string, ContextContribution>()
  for (const contribution of allocation.kept) byProvider.set(contribution.providerId, contribution)

  const cachePrefixKeys: string[] = []
  for (const contribution of allocation.kept) {
    if (contribution.layer === "stable" && contribution.cacheKey) cachePrefixKeys.push(contribution.cacheKey)
  }

  const retained: RetentionEntry[] = allocation.kept.map((c) => ({
    providerId: c.providerId,
    category: "retained",
    reason: "retained",
    detail: c.content.trim() === "" ? "metadata-only" : undefined,
  }))

  const compressed: RetentionEntry[] = allocation.compressed.map((t) => ({
    providerId: t.providerId,
    category: "compressed",
    reason: "semantic-trim",
    mode: "semantic",
    detail: t.detail,
  }))

  for (const trim of allocation.trimmed) {
    retentionDropped.push({
      providerId: trim.providerId,
      category: "dropped",
      reason: trim.revalidated ? "revalidate" : trim.mode === "semantic" ? "semantic-trim" : trim.mode === "wholesale" ? "wholesale-drop" : "budget",
      mode: trim.mode,
      detail: trim.detail,
    })
  }

  return {
    contributions: allocation.kept,
    byProvider,
    dropped,
    budget: allocation,
    cachePrefixKeys,
    warnings,
    // ── K29/K30/K34/K52 ──
    entrypoint: PIPELINE_ENTRYPOINT,
    budgetMode,
    retention: {
      retained,
      compressed,
      archived: [],
      dropped: retentionDropped,
      coverageGate: {
        facts: gate.facts,
        protected: [...gate.protectedProviderIds],
        intercepted: [...allocation.protectedHits],
        uncovered: uncovered.map((f) => f.id),
      },
      warnings: [...warnings],
    },
    trace,
  }
}
