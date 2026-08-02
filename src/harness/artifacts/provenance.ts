/** Artifact provenance (H8, plan §14.1): id generation, content hashing, and
 *  the createArtifact factory that stamps producedBy/createdAt so every
 *  artifact records who produced it and when.
 */

import { createHash } from "node:crypto"
import type { HarnessArtifact, HarnessArtifactKind, HarnessArtifactStatus } from "../contracts/artifact"

let nextArtifactId = 0

/** Generate a unique artifact ID (same scheme as generateEvidenceId). */
export function generateArtifactId(): string {
  nextArtifactId++
  return `art_${Date.now()}_${nextArtifactId}`
}

/** Reset the ID counter (for test reproducibility). */
export function resetArtifactIdCounter(start = 0): void {
  nextArtifactId = start
}

/** SHA-256 hex digest of artifact content. */
export function computeContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

/** Content-ref prefix for the artifact store's content storage. */
export const CONTENT_REF_PREFIX = "content:"

/** Build a content ref from a content hash (deduplicated in the store). */
export function contentRefFromHash(hash: string): string {
  return `${CONTENT_REF_PREFIX}${hash}`
}

export interface CreateArtifactInput {
  runId: string
  kind: HarnessArtifactKind
  status: HarnessArtifactStatus
  /** Ref into the store's content storage. */
  contentRef: string
  /** SHA-256 of the content (usually the same hash the ref was built from). */
  contentHash: string
  /** Who produced this artifact (tool name, verifier name, "planning", …). */
  producedBy: string
  nodeRunId?: string
  workspaceHash?: string
  relevantFileHashes?: Record<string, string>
  createdAt?: number
}

/** Factory: stamp provenance fields onto a new artifact. */
export function createArtifact(input: CreateArtifactInput): HarnessArtifact {
  return {
    artifactId: generateArtifactId(),
    runId: input.runId,
    nodeRunId: input.nodeRunId,
    kind: input.kind,
    status: input.status,
    contentRef: input.contentRef,
    contentHash: input.contentHash,
    workspaceHash: input.workspaceHash,
    relevantFileHashes: input.relevantFileHashes
      ? { ...input.relevantFileHashes }
      : undefined,
    producedBy: input.producedBy,
    createdAt: input.createdAt ?? Date.now(),
  }
}
