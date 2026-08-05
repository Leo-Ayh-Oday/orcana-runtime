/** Tool Runtime 2.0 (RT-4): output limiting — large results go to the
 *  artifact store; the model receives a preview + artifact reference.
 *
 *  Never returns megabytes to the caller: content over the budget is stored
 *  verbatim in the run's artifact store (hash-deduplicated content map) and
 *  the returned preview carries the artifact id for retrieval.
 */

import { createHash } from "node:crypto"
import type { ArtifactStore, HarnessArtifactKind } from "../contracts/artifact"

/** Matches the legacy shell cap (SHELL_RESULT_MAX_CHARS) — the new floor. */
export const DEFAULT_MAX_OUTPUT_BYTES = 8000

export interface LimitedOutput {
  /** Content as the caller should see (full when under budget). */
  preview: string
  truncated: boolean
  /** Artifact id of the full content, present iff truncated + store available. */
  artifactId?: string
  contentHash?: string
}

export interface LimitOutputInput {
  content: string
  /** Defaults to DEFAULT_MAX_OUTPUT_BYTES. */
  maxBytes?: number
  runId: string
  producedBy: string
  store?: ArtifactStore
  kind?: HarnessArtifactKind
  nodeRunId?: string
}

export async function limitOutput(input: LimitOutputInput): Promise<LimitedOutput> {
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  if (input.content.length <= maxBytes) {
    return { preview: input.content, truncated: false }
  }
  const preview = input.content.slice(0, maxBytes)
  if (!input.store) {
    // No store: degrade to plain truncation (legacy behavior) — never throw.
    return { preview, truncated: true }
  }
  const contentHash = createHash("sha256").update(input.content).digest("hex")
  const contentRef = await input.store.storeContent(input.content)
  const artifactId = `out_${input.runId.slice(0, 8)}_${contentHash.slice(0, 12)}`
  await input.store.put({
    artifactId,
    runId: input.runId,
    nodeRunId: input.nodeRunId,
    kind: input.kind ?? "tool_result",
    status: "valid",
    contentRef,
    contentHash,
    producedBy: input.producedBy,
    createdAt: Date.now(),
  })
  return { preview, truncated: true, artifactId, contentHash }
}
