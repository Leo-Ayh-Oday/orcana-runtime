/** [PR 6] Evidence Ledger — structured verification evidence with hard completion gate.
 *
 *  Replaces ad-hoc `verificationEvidence: Partial<Record<VerificationKind, string>>`
 *  with timestamped, linked evidence entries. Four evidence types:
 *    - typecheck — static analysis (tsc, lint)
 *    - test — test runner output
 *    - build — build/compile success
 *    - manual — human review sign-off, manual QA, etc.
 *
 *  `canClaimDone()` is the single hard-check entry point: no passed evidence
 *  for a required kind → cannot claim done.
 */

import type { TransactionEvidenceBinding, VerificationKind, VerificationResult } from "../verification/result"
import type { TaskTracker } from "./task-tracker"

// ── Evidence types ──

/** The four evidence types. Narrower than VerificationKind (which includes lint/smoke/unknown). */
export type EvidenceKind = "typecheck" | "test" | "build" | "manual"

/** A single piece of verification evidence. */
export interface EvidenceEntry {
  id: string
  kind: EvidenceKind
  /** The command that produced this evidence (e.g. "tsc --noEmit"). */
  command?: string
  /** Summary or snippet of the verification output. */
  output: string
  /** Whether the verification passed. Only passed evidence counts toward canClaimDone. */
  passed: boolean
  /** Number of typecheck issues in the output (typecheck kind only). */
  issues?: number
  /** Unix timestamp (ms) when this evidence was collected. */
  timestamp: number
  /** Optional link to the PatchTransaction that produced the code under verification. */
  txId?: string
  /** [PR-2 / I-2] Write-generation at collection time. If a later write bumps the
   *  runtime write-generation past this value, this evidence verified an older code
   *  state and is considered stale by the completion gate. */
  generation?: number
  /** Constant-size snapshot of successful commit history at collection time. */
  transaction?: TransactionEvidenceBinding
  /** H8: the HarnessArtifact this evidence supports (§14.2 — artifact = produced
   *  thing, evidence = the claim the artifact supports). */
  artifactId?: string
  /** H8: marked stale by artifact freshness invalidation (§14.3). A stale entry
   *  can never satisfy the completion gate. */
  stale?: boolean
}

/** Collection of all evidence gathered during a task. */
export interface EvidenceLedger {
  entries: EvidenceEntry[]
}

/** Result of the canClaimDone() hard check. */
export interface CanClaimDoneResult {
  canClaim: boolean
  /** Human-readable reasons why completion cannot be claimed. */
  missing: string[]
  /** Hard blockers (distinct from soft warnings). */
  blocked: string[]
  /** Evidence kinds required by the task tracker. */
  requiredKinds: EvidenceKind[]
  /** Evidence kinds that have at least one passed entry. */
  satisfiedKinds: EvidenceKind[]
  /** Evidence kinds that are required but lack passed evidence. */
  unsatisfiedKinds: EvidenceKind[]
}

// ── Mapping: VerificationKind → EvidenceKind ──

/** Map a VerificationKind to its canonical EvidenceKind.
 *
 *  Mapping:
 *  - typecheck → typecheck
 *  - lint → typecheck (static analysis)
 *  - test → test
 *  - smoke → test (runtime verification)
 *  - build → build
 *  - unknown → null (cannot auto-classify)
 */
export function toEvidenceKind(kind: VerificationKind): EvidenceKind | null {
  switch (kind) {
    case "typecheck":
    case "lint":
      return "typecheck"
    case "test":
    case "smoke":
      return "test"
    case "build":
      return "build"
    case "unknown":
      return null
  }
}

/** Human-readable label for an evidence kind. */
export function evidenceKindLabel(kind: EvidenceKind): string {
  switch (kind) {
    case "typecheck": return "类型检查"
    case "test": return "测试"
    case "build": return "构建"
    case "manual": return "人工验证"
  }
}

// ── Factory ──

let nextEvidenceId = 0

/** Create a fresh evidence ledger. */
export function createEvidenceLedger(): EvidenceLedger {
  return { entries: [] }
}

/** Generate a unique evidence entry ID. */
export function generateEvidenceId(): string {
  nextEvidenceId++
  return `evi_${Date.now()}_${nextEvidenceId}`
}

// ── Ledger operations ──

/** Reset the ID counter (for test reproducibility). */
export function resetEvidenceIdCounter(start = 0): void {
  nextEvidenceId = start
}

/** Add an evidence entry to the ledger. */
export function addEvidence(ledger: EvidenceLedger, entry: EvidenceEntry): void {
  ledger.entries.push(entry)
}

/** H8: mark every entry bound to the given artifact stale (§14.3). */
export function markEvidenceStale(ledger: EvidenceLedger, artifactId: string): void {
  for (const entry of ledger.entries) {
    if (entry.artifactId === artifactId) entry.stale = true
  }
}

/** Check whether the ledger has at least one passed evidence entry of the given kind. */
export function hasEvidence(ledger: EvidenceLedger, kind: EvidenceKind): boolean {
  return ledger.entries.some(e => e.kind === kind && e.passed)
}

/** Get all evidence entries of a given kind (passed or not). */
export function getEvidence(ledger: EvidenceLedger, kind: EvidenceKind): EvidenceEntry[] {
  return ledger.entries.filter(e => e.kind === kind)
}

/** Get the latest passed evidence entry for a kind, or null. */
export function latestPassedEvidence(ledger: EvidenceLedger, kind: EvidenceKind): EvidenceEntry | null {
  const passed = ledger.entries.filter(e => e.kind === kind && e.passed)
  if (passed.length === 0) return null
  return passed.reduce((latest, e) => e.timestamp > latest.timestamp ? e : latest)
}

/** Get the latest evidence entry of a kind in collection order (passed or not), or null.
 *  Uses array (insertion) order rather than timestamp so same-ms entries resolve to the
 *  actually-latest one. */
export function latestEvidence(ledger: EvidenceLedger, kind: EvidenceKind): EvidenceEntry | null {
  for (let i = ledger.entries.length - 1; i >= 0; i--) {
    const e = ledger.entries[i]!
    if (e.kind === kind) return e
  }
  return null
}

/** [PR-2 / I-2] The state-aware evidence check used by the completion gate.
 *
 *  Unlike `hasEvidence` ("any passed entry EVER"), this enforces the latest runtime
 *  state the gate can authoritatively identify:
 *    L1 — the MOST RECENT entry of the kind must be passed (a later failed
 *         re-verification invalidates an earlier pass).
 *    L2 — if `currentGeneration` is provided and the entry carries a generation,
 *         they must match (no writes since it was verified; otherwise it's stale).
 *    L3 — if a transaction binding is required, the evidence must carry the same
 *         successful PatchTransaction commit-history identity. This history is
 *         append-only in this slice; rollback invalidation is handled separately.
 *
 *  Backward compatible for callers that omit `currentGeneration`: those enforce L1
 *  only. Once the current generation is known, evidence must carry the same generation;
 *  an unstamped legacy entry cannot prove freshness and fails closed.
 */
export function hasFreshPassingEvidence(
  ledger: EvidenceLedger,
  kind: EvidenceKind,
  currentGeneration?: number,
  evidenceBinding?: TransactionEvidenceBinding,
  requireEvidenceBinding = false,
): boolean {
  const latest = latestEvidence(ledger, kind)
  if (!latest || latest.stale || !latest.passed) return false // L1 (H8: stale entries never satisfy)
  if (currentGeneration !== undefined && latest.generation !== currentGeneration) {
    return false // L2 — code changed since this evidence was collected
  }
  if (requireEvidenceBinding && !evidenceBinding) return false // L3 — observed write bypassed PatchTransaction
  if (evidenceBinding) {
    const transactionMatches = latest.transaction?.stateId === evidenceBinding.stateId
      && latest.transaction.transactionCount === evidenceBinding.transactionCount
      && latest.transaction.latestTransactionId === evidenceBinding.latestTransactionId
    if (!transactionMatches) {
      return false // L3 — verification belongs to a different committed transaction state
    }
  }
  return true
}

function cloneTransactionEvidenceBinding(
  binding: TransactionEvidenceBinding | undefined,
): TransactionEvidenceBinding | undefined {
  return binding ? { ...binding } : undefined
}

// ── Ingestion: VerificationResult → EvidenceEntry ──

/** Convert a VerificationResult into evidence entries and add them to the ledger.
 *
 *  A single VerificationResult may produce evidence for its primary kind.
 *  Returns the newly added entries.
 */
export function ingestVerificationResult(ledger: EvidenceLedger, result: VerificationResult, txId?: string, generation?: number): EvidenceEntry | null {
  const kind = toEvidenceKind(result.kind)
  if (!kind) return null

  const entry: EvidenceEntry = {
    id: generateEvidenceId(),
    kind,
    command: result.command,
    output: result.summary,
    passed: result.passed,
    timestamp: Date.now(),
    txId,
    generation: result.generation ?? generation,
    transaction: cloneTransactionEvidenceBinding(result.transaction),
  }
  addEvidence(ledger, entry)
  return entry
}

/** Batch-ingest multiple verification results. */
export function ingestVerificationResults(ledger: EvidenceLedger, results: VerificationResult[], txId?: string, generation?: number): EvidenceEntry[] {
  const entries: EvidenceEntry[] = []
  for (const r of results) {
    const entry = ingestVerificationResult(ledger, r, txId, generation)
    if (entry) entries.push(entry)
  }
  return entries
}

/** Add a typecheck evidence entry (e.g. from the round's batch tsc run). */
export function ingestTypecheck(ledger: EvidenceLedger, opts: {
  passed: boolean
  issues: number
  output: string
  command?: string
  generation?: number
}): EvidenceEntry {
  const entry: EvidenceEntry = {
    id: generateEvidenceId(),
    kind: "typecheck",
    command: opts.command,
    output: opts.output,
    passed: opts.passed,
    issues: opts.issues,
    timestamp: Date.now(),
    generation: opts.generation,
  }
  addEvidence(ledger, entry)
  return entry
}

/** Derive the lastTypecheck compatibility view from the ledger's latest typecheck entry. */
export function deriveLastTypecheck(ledger: EvidenceLedger): { passed: boolean; issues: number; output?: string } | undefined {
  const latest = latestEvidence(ledger, "typecheck")
  if (!latest) return undefined
  return { passed: latest.passed, issues: latest.issues ?? 0, output: latest.output }
}

/** Add a manual evidence entry (e.g. code review sign-off, manual QA). */
export function addManualEvidence(ledger: EvidenceLedger, opts: {
  description: string
  passed: boolean
  txId?: string
  generation?: number
  transaction?: TransactionEvidenceBinding
}): EvidenceEntry {
  const entry: EvidenceEntry = {
    id: generateEvidenceId(),
    kind: "manual",
    command: undefined,
    output: opts.description,
    passed: opts.passed,
    timestamp: Date.now(),
    txId: opts.txId,
    generation: opts.generation,
    transaction: cloneTransactionEvidenceBinding(opts.transaction),
  }
  addEvidence(ledger, entry)
  return entry
}

// ── The hard check: canClaimDone ──

/** Determine which EvidenceKinds are required based on the task tracker's
 *  requiredVerificationKinds. */
export function requiredEvidenceKinds(tracker: TaskTracker | null): EvidenceKind[] {
  if (!tracker || tracker.requiredVerificationKinds.length === 0) return []
  const kinds = new Set<EvidenceKind>()
  for (const vk of tracker.requiredVerificationKinds) {
    const ek = toEvidenceKind(vk)
    if (ek) kinds.add(ek)
  }
  return [...kinds]
}

/** The single hard-check entry point for claiming task completion.
 *
 *  Checks:
 *  1. No tracker and no explicit requirements → can claim (no structured task)
 *  2. All steps must be done (no pending/running)
 *  3. All required evidence kinds must have fresh passed evidence
 *  4. All required files must exist on disk
 *
 *  Returns a structured result with canClaim + detailed missing/blocked lists.
 */
export function canClaimDone(params: {
  tracker: TaskTracker | null
  evidence: EvidenceLedger
  cwd?: string
  /** Explicit evidence requirements for flows such as narrow_edit that do not
   * create a TaskTracker but still make a verified-completion claim. */
  requiredKinds?: EvidenceKind[]
  /** [PR-2 / I-2] Current write-generation. When provided, required evidence must
   *  have been collected at this generation (no writes since) — else it is stale. */
  currentGeneration?: number
  /** Commit-history identity that required evidence must match. */
  evidenceBinding?: TransactionEvidenceBinding
  /** Fail closed when writes occurred but no authoritative commit history exists. */
  requireEvidenceBinding?: boolean
}): CanClaimDoneResult {
  const {
    tracker,
    evidence,
    cwd,
    requiredKinds: explicitRequiredKinds = [],
    currentGeneration,
    evidenceBinding,
    requireEvidenceBinding = false,
  } = params
  const missing: string[] = []
  const blocked: string[] = []

  // Unstructured chat has no evidence contract. Tracker-less flows may still
  // opt into one through explicit requirements (for example narrow_edit).
  if (!tracker && explicitRequiredKinds.length === 0) {
    return {
      canClaim: true,
      missing: [],
      blocked: [],
      requiredKinds: [],
      satisfiedKinds: [],
      unsatisfiedKinds: [],
    }
  }

  // Check: all steps must be done
  const undoneSteps = tracker?.steps.filter(s => s.status !== "done") ?? []
  if (undoneSteps.length > 0) {
    for (const s of undoneSteps) {
      missing.push(`步骤未完成: ${s.title}`)
    }
  }

  // Check: required files exist
  if (tracker && cwd) {
    const { existsSync } = require("node:fs")
    const { resolve } = require("node:path")
    for (const file of tracker.requiredFiles) {
      const candidates = [file, `blog/${file}`, `client/${file}`]
      const found = candidates.some(candidate => existsSync(resolve(cwd, candidate)))
      if (!found) {
        missing.push(`缺少文件: ${file}`)
      }
    }
  }

  // Check: required evidence
  const required = [...new Set([...requiredEvidenceKinds(tracker), ...explicitRequiredKinds])]
  const satisfied: EvidenceKind[] = []
  const unsatisfied: EvidenceKind[] = []

  for (const kind of required) {
    if (hasFreshPassingEvidence(evidence, kind, currentGeneration, evidenceBinding, requireEvidenceBinding)) {
      satisfied.push(kind)
    } else {
      unsatisfied.push(kind)
      missing.push(`缺少验证证据: ${evidenceKindLabel(kind)}`)
    }
  }

  // Hard blockers: unsatisfied required evidence kinds
  if (unsatisfied.length > 0) {
    blocked.push(
      `必需的验证证据缺失: ${unsatisfied.map(evidenceKindLabel).join(", ")}`
    )
  }

  // Hard blockers: undone steps
  if (undoneSteps.length > 0) {
    blocked.push(
      `仍有 ${undoneSteps.length} 个步骤未完成`
    )
  }

  return {
    canClaim: missing.length === 0,
    missing,
    blocked,
    requiredKinds: required,
    satisfiedKinds: satisfied,
    unsatisfiedKinds: unsatisfied,
  }
}

// ── Formatting ──

/** Format evidence ledger status for model-facing context. */
export function formatEvidenceLedgerStatus(ledger: EvidenceLedger): string {
  if (ledger.entries.length === 0) return "暂无验证证据"

  const lines: string[] = ["## 验证证据", ""]
  const byKind: Record<EvidenceKind, EvidenceEntry[]> = {
    typecheck: [],
    test: [],
    build: [],
    manual: [],
  }

  for (const e of ledger.entries) {
    byKind[e.kind].push(e)
  }

  for (const kind of ["typecheck", "test", "build", "manual"] as EvidenceKind[]) {
    const entries = byKind[kind]
    if (entries.length === 0) continue
    const passed = entries.filter(e => e.passed).length
    const total = entries.length
    const latest = entries.reduce((a, b) => a.timestamp > b.timestamp ? a : b)
    const icon = passed === total ? "✓" : passed > 0 ? "⚠" : "✗"
    lines.push(`${icon} **${evidenceKindLabel(kind)}**: ${passed}/${total} 通过`)
    if (latest.command) {
      lines.push(`  命令: \`${latest.command}\``)
    }
    lines.push(`  输出: ${latest.output.slice(0, 200)}`)
    lines.push("")
  }

  return lines.join("\n")
}

/** Format a canClaimDone result for model-facing injection. */
export function formatCanClaimDoneBlocked(result: CanClaimDoneResult): string {
  if (result.canClaim) return ""

  const lines = [
    "## 完成被阻止",
    "以下条件未满足，无法声明任务完成：",
    "",
    ...result.blocked.map(b => `- **${b}**`),
    "",
    "### 缺失项",
    ...result.missing.map(m => `- ${m}`),
  ]

  if (result.unsatisfiedKinds.length > 0) {
    lines.push(
      "",
      `需要但未满足的证据类型: ${result.unsatisfiedKinds.map(evidenceKindLabel).join(", ")}`,
      `已满足的证据类型: ${result.satisfiedKinds.length > 0 ? result.satisfiedKinds.map(evidenceKindLabel).join(", ") : "无"}`,
    )
  }

  return lines.join("\n")
}

// ── Serialization ──

export interface SerializedEvidenceEntry {
  id: string
  kind: EvidenceKind
  command?: string
  output: string
  passed: boolean
  timestamp: number
  txId?: string
  generation?: number
  transaction?: TransactionEvidenceBinding
  artifactId?: string
  stale?: boolean
}

export interface SerializedLedger {
  entries: SerializedEvidenceEntry[]
}

/** Serialize evidence ledger for checkpoint/transmission. */
export function serializeLedger(ledger: EvidenceLedger): SerializedLedger {
  return {
    entries: ledger.entries.map(e => ({
      id: e.id,
      kind: e.kind,
      command: e.command,
      output: e.output,
      passed: e.passed,
      timestamp: e.timestamp,
      txId: e.txId,
      generation: e.generation,
      transaction: cloneTransactionEvidenceBinding(e.transaction),
      artifactId: e.artifactId,
      stale: e.stale,
    })),
  }
}

/** Deserialize evidence ledger from checkpoint/transmission. */
export function deserializeLedger(data: SerializedLedger): EvidenceLedger {
  return {
    entries: data.entries.map(e => ({
      id: e.id,
      kind: e.kind,
      command: e.command,
      output: e.output,
      passed: e.passed,
      timestamp: e.timestamp,
      txId: e.txId,
      generation: e.generation,
      transaction: cloneTransactionEvidenceBinding(e.transaction),
      artifactId: e.artifactId,
      stale: e.stale,
    })),
  }
}
