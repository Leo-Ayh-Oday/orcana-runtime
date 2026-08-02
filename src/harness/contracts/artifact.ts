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

  producedBy: string
  createdAt: number
}

export interface ArtifactStore {
  put(artifact: HarnessArtifact): Promise<void>
  get(artifactId: string): Promise<HarnessArtifact | null>
  markStale(artifactId: string): Promise<void>
}
