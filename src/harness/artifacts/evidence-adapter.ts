/** Evidence ↔ Artifact binding (H8, plan §14.2).
 *
 *  Artifact = the actual produced thing; Evidence = what the artifact
 *  supports. Every verification artifact produced through this adapter is
 *  bound to its EvidenceEntry via EvidenceEntry.artifactId, so freshness
 *  invalidation (refreshArtifactFreshness) can mark both sides stale.
 *  Large output goes into the store's content map; artifacts keep ref + hash.
 */

import type { ArtifactStore, HarnessArtifact, HarnessArtifactKind, HarnessArtifactStatus } from "../contracts/artifact"
import type { EvidenceLedger, EvidenceEntry } from "../../agent/evidence-ledger"
import { addEvidence, generateEvidenceId, toEvidenceKind } from "../../agent/evidence-ledger"
import type { TransactionEvidenceBinding, VerificationKind, VerificationResult } from "../../verification/result"
import { computeContentHash, createArtifact } from "./provenance"

/** Map a VerificationKind to its HarnessArtifactKind (null = cannot classify). */
export function toArtifactKind(kind: VerificationKind): HarnessArtifactKind | null {
  switch (kind) {
    case "typecheck":
    case "lint":
      return "typecheck_result"
    case "test":
    case "smoke":
      return "test_result"
    case "build":
      return "build_result"
    case "unknown":
      return null
  }
}

export interface IngestVerificationWithArtifactInput {
  store: ArtifactStore
  ledger: EvidenceLedger
  runId: string
  result: VerificationResult
  producedBy: string
  generation?: number
  transaction?: TransactionEvidenceBinding
  workspaceHash?: string
  relevantFileHashes?: Record<string, string>
}

export interface ArtifactEvidencePair {
  artifact: HarnessArtifact
  entry: EvidenceEntry
}

/** Ingest a VerificationResult as an artifact + bound evidence entry.
 *  Returns null when the kind cannot be classified (same as
 *  ingestVerificationResult returning null for unknown kinds). */
export async function ingestVerificationWithArtifact(
  input: IngestVerificationWithArtifactInput,
): Promise<ArtifactEvidencePair | null> {
  const kind = toArtifactKind(input.result.kind)
  if (!kind) return null

  const contentRef = await input.store.storeContent(input.result.summary)
  const status: HarnessArtifactStatus = input.result.passed ? "valid" : "failed"
  const artifact = createArtifact({
    runId: input.runId,
    kind,
    status,
    contentRef,
    contentHash: computeContentHash(input.result.summary),
    producedBy: input.producedBy,
    workspaceHash: input.workspaceHash,
    relevantFileHashes: input.relevantFileHashes,
  })
  await input.store.put(artifact)

  const entry: EvidenceEntry = {
    id: generateEvidenceId(),
    kind: toEvidenceKind(input.result.kind)!,
    command: input.result.command,
    output: input.result.summary,
    passed: input.result.passed,
    issues: input.result.issues,
    timestamp: Date.now(),
    txId: undefined,
    generation: input.result.generation ?? input.generation,
    // The result's own transaction snapshot wins (mirrors ingestVerificationResult).
    transaction: (input.result.transaction ?? input.transaction)
      ? { ...(input.result.transaction ?? input.transaction!) }
      : undefined,
    artifactId: artifact.artifactId,
  }
  addEvidence(input.ledger, entry)
  return { artifact, entry }
}

export interface IngestTypecheckWithArtifactInput {
  store: ArtifactStore
  ledger: EvidenceLedger
  runId: string
  passed: boolean
  /** RC-01: 六态验证状态。 */
  status?: string
  issues: number
  output: string
  command?: string
  producedBy: string
  generation?: number
  workspaceHash?: string
  relevantFileHashes?: Record<string, string>
}

/** Ingest the round's batch tsc run as a typecheck_result artifact + evidence
 *  (the coordinator's authoritative typecheck path). */
export async function ingestTypecheckWithArtifact(
  input: IngestTypecheckWithArtifactInput,
): Promise<ArtifactEvidencePair> {
  const contentRef = await input.store.storeContent(input.output)
  const artifact = createArtifact({
    runId: input.runId,
    kind: "typecheck_result",
    status: input.passed ? "valid" : "failed",
    contentRef,
    contentHash: computeContentHash(input.output),
    producedBy: input.producedBy,
    workspaceHash: input.workspaceHash,
    relevantFileHashes: input.relevantFileHashes,
  })
  await input.store.put(artifact)

  const entry: EvidenceEntry = {
    id: generateEvidenceId(),
    kind: "typecheck",
    command: input.command,
    output: input.output,
    passed: input.passed,
    status: input.status,
    issues: input.issues,
    timestamp: Date.now(),
    generation: input.generation,
    artifactId: artifact.artifactId,
  }
  addEvidence(input.ledger, entry)
  return { artifact, entry }
}

export interface PutPatchArtifactInput {
  store: ArtifactStore
  runId: string
  /** The PatchTransaction txId this patch realizes. */
  txId: string
  diff: string
  /** Files touched by the patch (freshness bindings). */
  files: string[]
  producedBy: string
  workspaceHash?: string
  /** Hashes of the patched files as of commit time. */
  relevantFileHashes?: Record<string, string>
}

/** Record a committed patch; the previous valid patch is superseded. */
export async function putPatchArtifact(input: PutPatchArtifactInput): Promise<HarnessArtifact> {
  for (const old of await input.store.findByKind("patch")) {
    if (old.status === "valid") await input.store.markSuperseded(old.artifactId)
  }

  const contentRef = await input.store.storeContent(input.diff)
  const artifact = createArtifact({
    runId: input.runId,
    kind: "patch",
    status: "valid",
    contentRef,
    contentHash: computeContentHash(input.diff),
    producedBy: input.producedBy,
    workspaceHash: input.workspaceHash,
    relevantFileHashes: input.relevantFileHashes,
    txId: input.txId,
  })
  await input.store.put(artifact)
  return artifact
}

export interface PutPlanArtifactInput {
  store: ArtifactStore
  runId: string
  planText: string
  producedBy: string
  workspaceHash?: string
}

/** Record the activated plan as a plan artifact (plan_ready / approval). */
export async function putPlanArtifact(input: PutPlanArtifactInput): Promise<HarnessArtifact> {
  for (const old of await input.store.findByKind("plan")) {
    if (old.status === "valid") await input.store.markSuperseded(old.artifactId)
  }

  const contentRef = await input.store.storeContent(input.planText)
  const artifact = createArtifact({
    runId: input.runId,
    kind: "plan",
    status: "valid",
    contentRef,
    contentHash: computeContentHash(input.planText),
    producedBy: input.producedBy,
    workspaceHash: input.workspaceHash,
  })
  await input.store.put(artifact)
  return artifact
}

export interface PutRippleArtifactInput {
  store: ArtifactStore
  runId: string
  report: string
  producedBy: string
  workspaceHash?: string
  relevantFileHashes?: Record<string, string>
}

/** Record a ripple verification report as a ripple_report artifact. */
export async function putRippleArtifact(input: PutRippleArtifactInput): Promise<HarnessArtifact> {
  const contentRef = await input.store.storeContent(input.report)
  const artifact = createArtifact({
    runId: input.runId,
    kind: "ripple_report",
    status: "valid",
    contentRef,
    contentHash: computeContentHash(input.report),
    producedBy: input.producedBy,
    workspaceHash: input.workspaceHash,
    relevantFileHashes: input.relevantFileHashes,
  })
  await input.store.put(artifact)
  return artifact
}
