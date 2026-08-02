/** Artifact store (H8, plan §14.1/§14.2): full in-memory implementation
 *  replacing the H3 placeholder. Artifacts keep metadata only — large content
 *  lives in the store's content map, referenced by "content:<sha256>" (hash
 *  deduplicated). Status transitions (stale/superseded) are idempotent.
 */

import { createHash } from "node:crypto"
import type { ArtifactStore, HarnessArtifact, HarnessArtifactKind } from "../contracts/artifact"
import { contentRefFromHash } from "./provenance"

export function createArtifactStore(): ArtifactStore {
  const artifacts = new Map<string, HarnessArtifact>()
  const content = new Map<string, string>()

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
