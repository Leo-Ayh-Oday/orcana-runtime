/** Artifact store (H8, plan §14.1/§14.2): full in-memory implementation
 *  replacing the H3 placeholder. Artifacts keep metadata only — large content
 *  lives in the store's content map, referenced by "content:<sha256>" (hash
 *  deduplicated). Status transitions (stale/superseded) are idempotent.
 */

import { createHash } from "node:crypto"
import type { ArtifactStore, HarnessArtifact, HarnessArtifactKind } from "../contracts/artifact"
import { contentRefFromHash } from "./provenance"

/** G0-3: initial state for a restored store — artifacts + resolved content
 *  hydrated synchronously (the store interface is async, restore is sync). */
export interface ArtifactStoreInitialState {
  artifacts?: HarnessArtifact[]
  contents?: Array<{ ref: string; value: string }>
}

export function createArtifactStore(initial?: ArtifactStoreInitialState): ArtifactStore {
  const artifacts = new Map<string, HarnessArtifact>(
    (initial?.artifacts ?? []).map((a) => [a.artifactId, { ...a }]),
  )
  const content = new Map<string, string>(
    (initial?.contents ?? []).map((c) => [c.ref, c.value]),
  )

  return {
    async put(artifact) {
      artifacts.set(artifact.artifactId, { ...artifact })
    },

    async get(artifactId) {
      const artifact = artifacts.get(artifactId)
      return artifact ? { ...artifact } : null
    },

    async markStale(artifactId) {
      const artifact = artifacts.get(artifactId)
      if (artifact && artifact.status !== "stale" && artifact.status !== "superseded") {
        artifact.status = "stale"
      }
    },

    async markSuperseded(artifactId) {
      const artifact = artifacts.get(artifactId)
      if (artifact && artifact.status !== "superseded") {
        artifact.status = "superseded"
      }
    },

    async findByKind(kind: HarnessArtifactKind) {
      return [...artifacts.values()].filter(a => a.kind === kind).map(a => ({ ...a }))
    },

    async entries() {
      return [...artifacts.values()].map(a => ({ ...a }))
    },

    async storeContent(c: string) {
      const ref = contentRefFromHash(createHash("sha256").update(c).digest("hex"))
      if (!content.has(ref)) content.set(ref, c)
      return ref
    },

    async getContent(ref) {
      return content.get(ref) ?? null
    },
  }
}
