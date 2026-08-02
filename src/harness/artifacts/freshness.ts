/** Artifact / evidence freshness (H8, plan §14.3).
 *
 *  Every artifact may bind a workspaceHash and per-file hashes of its
 *  relevant files. When the workspace or a relevant file changes, the
 *  artifact is stale and the evidence bound to it can no longer satisfy the
 *  completion gate. refreshArtifactFreshness scans the store once and marks
 *  both sides in lockstep.
 */

import { join } from "node:path"
import { existsSync } from "node:fs"
import { fingerprintFile } from "../../file-state/file-fingerprint"
import type { ArtifactStore } from "../contracts/artifact"
import type { EvidenceLedger } from "../../agent/evidence-ledger"
import { markEvidenceStale } from "../../agent/evidence-ledger"

/** File-hash kinds that represent verification claims over the workspace. */
const VERIFICATION_ARTIFACT_KINDS = new Set(["typecheck_result", "test_result", "build_result"])

/** Compute current hashes for the given files (missing files are dropped —
 *  a deleted file counts as a change for freshness purposes). */
export function computeRelevantFileHashes(projectRoot: string, files: string[]): Record<string, string> {
  const hashes: Record<string, string> = {}
  for (const file of files) {
    const full = join(projectRoot, file)
    if (!existsSync(full)) continue
    const fingerprint = fingerprintFile(full)
    if (fingerprint) hashes[file] = fingerprint.sha256
  }
  return hashes
}

export interface RefreshArtifactFreshnessInput {
  store: ArtifactStore
  ledger: EvidenceLedger
  /** Current workspace hash (computed by the caller, same source as H6). */
  workspaceHash: string
  /** Current per-file hashes to compare against artifact.relevantFileHashes. */
  relevantFileHashes: Record<string, string>
}

/** Mark stale every artifact whose freshness bindings no longer match, and
 *  the evidence bound to them. Returns the stale artifact IDs. */
export async function refreshArtifactFreshness(input: RefreshArtifactFreshnessInput): Promise<string[]> {
  const { store, ledger, workspaceHash, relevantFileHashes } = input
  const staleIds: string[] = []

  for (const artifact of await store.entries()) {
    if (artifact.status === "stale" || artifact.status === "superseded") continue

    let stale = false
    // Whole-workspace drift invalidates verification claims (§14.3).
    if (artifact.workspaceHash !== undefined
      && artifact.workspaceHash !== workspaceHash
      && VERIFICATION_ARTIFACT_KINDS.has(artifact.kind)) {
      stale = true
    }
    // Per-file drift invalidates artifacts bound to those files.
    if (!stale && artifact.relevantFileHashes) {
      for (const [file, hash] of Object.entries(artifact.relevantFileHashes)) {
        if (relevantFileHashes[file] !== hash) {
          stale = true
          break
        }
      }
    }

    if (stale) {
      await store.markStale(artifact.artifactId)
      markEvidenceStale(ledger, artifact.artifactId)
      staleIds.push(artifact.artifactId)
    }
  }

  return staleIds
}
