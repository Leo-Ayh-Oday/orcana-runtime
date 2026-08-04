/**
 * H0: Artifact contract.
 *
 * An artifact is an actual produced thing (plan, patch, test output, …).
 * Evidence is a separate claim: "artifact X supports claim Y". EvidenceLedger
 * stores artifact refs, not large command output.
 */

export type HarnessArtifactKind =
  | "plan"
  | "patch"
  | "tool_result"
  | "test_result"
  | "typecheck_result"
  | "build_result"
  | "ripple_report"
  | "research_source"
  | "checkpoint"
  | "delivery_report"

export type HarnessArtifactStatus = "valid" | "failed" | "stale" | "superseded"

export interface HarnessArtifact {
  artifactId: string
  runId: string
  nodeRunId?: string

  kind: HarnessArtifactKind
  status: HarnessArtifactStatus

  contentRef: string
  contentHash: string

  workspaceHash?: string
  relevantFileHashes?: Record<string, string>
  /** R1: the PatchTransaction txId this artifact realizes (patch artifacts). */
  txId?: string

  producedBy: string
  createdAt: number
}

export interface ArtifactStore {
  put(artifact: HarnessArtifact): Promise<void>
  get(artifactId: string): Promise<HarnessArtifact | null>
  markStale(artifactId: string): Promise<void>
  /** H8: mark an artifact superseded (a newer artifact of the same kind replaced it). */
  markSuperseded(artifactId: string): Promise<void>
  /** H8: list artifacts of a kind in insertion order. */
  findByKind(kind: HarnessArtifactKind): Promise<HarnessArtifact[]>
  /** H8: all artifacts in insertion order (used for snapshot artifactRefs). */
  entries(): Promise<HarnessArtifact[]>
  /** H8: store large content by hash — artifacts keep only ref + hash (§14.2). */
  storeContent(content: string): Promise<string>
  getContent(ref: string): Promise<string | null>
}
