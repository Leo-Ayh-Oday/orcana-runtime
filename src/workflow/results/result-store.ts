/** Result store (G1): per-node results + checkpoint persistence.
 *
 *  The scheduler writes a node result as soon as the node finishes
 *  (incremental checkpoint), so a crashed run can be restored without
 *  re-executing finished nodes. Persistence is best-effort — a failed
 *  checkpoint write never fails the run.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { redactForTrace } from "../../agent/secret-redactor"
import type { WorkflowNodeResult } from "../types"

/** M11: a checkpoint is bound to the graph digest and the workspace digest
 *  at write time — restoring a checkpoint written for a different graph or
 *  workspace is rejected (STALE_WORKFLOW_RESULT_RESTORED: 0). */
export interface CheckpointData {
  specId: string
  updatedAt: number
  /** Digest of the workflow spec (nodes/handlers/inputs/deps). */
  specDigest?: string
  /** Content hash of the project workspace at checkpoint time. */
  workspaceDigest?: string
  results: WorkflowNodeResult[]
}

export interface ResultStoreFreshness {
  specDigest?: string
  workspaceDigest?: string
}

export class ResultStore {
  private readonly results = new Map<string, WorkflowNodeResult>()
  private readonly specId: string
  private readonly checkpointFile?: string
  private readonly specDigest?: string
  private readonly workspaceDigest?: string

  constructor(specId: string, checkpointDir?: string, freshness?: ResultStoreFreshness) {
    this.specId = specId
    this.specDigest = freshness?.specDigest
    this.workspaceDigest = freshness?.workspaceDigest
    if (checkpointDir) this.checkpointFile = join(checkpointDir, `${specId}.json`)
  }

  put(result: WorkflowNodeResult): void {
    this.results.set(result.nodeId, result)
    this.persist()
  }

  get(nodeId: string): WorkflowNodeResult | undefined {
    return this.results.get(nodeId)
  }

  has(nodeId: string): boolean {
    return this.results.has(nodeId)
  }

  all(): WorkflowNodeResult[] {
    return [...this.results.values()]
  }

  /** M1: results as a lookup map (readiness evaluation). */
  allAsMap(): Map<string, WorkflowNodeResult> {
    return new Map(this.results)
  }

  /** Incremental checkpoint write (best-effort). */
  private persist(): void {
    if (!this.checkpointFile) return
    try {
      const data: CheckpointData = {
        specId: this.specId,
        updatedAt: Date.now(),
        specDigest: this.specDigest,
        workspaceDigest: this.workspaceDigest,
        results: [...this.results.values()],
      }
      mkdirSync(dirname(this.checkpointFile), { recursive: true })
      writeFileSync(this.checkpointFile, `${JSON.stringify(redactForTrace(data), null, 2)}\n`, "utf-8")
    } catch {
      // Never fail the run over a checkpoint write.
    }
  }

  /** Load a previous checkpoint (returns true when restored ≥1 result). */
  restore(checkpointDir: string): boolean {
    if (!this.checkpointFile && this.specId) {
      // restore() is called with a dir when the store was created without one.
      const file = join(checkpointDir, `${this.specId}.json`)
      return this.restoreFrom(file)
    }
    if (!this.checkpointFile) return false
    return this.restoreFrom(this.checkpointFile)
  }

  private restoreFrom(file: string): boolean {
    if (!existsSync(file)) return false
    try {
      const parsed = JSON.parse(readFileSync(file, "utf-8")) as CheckpointData
      if (parsed.specId !== this.specId) return false
      // M11: freshness fail-closed — a digest-bound store never accepts an
      // unbound checkpoint, and a mismatched digest rejects the whole
      // checkpoint (nodes re-execute instead of replaying stale results).
      if (this.specDigest !== undefined && parsed.specDigest !== this.specDigest) return false
      if (this.workspaceDigest !== undefined && parsed.workspaceDigest !== this.workspaceDigest) return false
      for (const result of parsed.results ?? []) {
        if (result && typeof result.nodeId === "string" && result.status) {
          this.results.set(result.nodeId, result)
        }
      }
      return this.results.size > 0
    } catch {
      return false
    }
  }
}
