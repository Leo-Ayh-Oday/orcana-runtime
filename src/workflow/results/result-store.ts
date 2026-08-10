/** Result store (G1): per-node results + checkpoint persistence.
 *
 *  The scheduler writes a node result as soon as the node finishes
 *  (incremental checkpoint), so a crashed run can be restored without
 *  re-executing finished nodes. Persistence is best-effort — a failed
 *  checkpoint write never fails the run.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs"
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

/** M12: spec ids are identifiers, never paths — the checkpoint file name
 *  joins the id directly. Fail closed at construction. */
export function isSafeSpecId(specId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(specId)
}

export class ResultStore {
  private readonly results = new Map<string, WorkflowNodeResult>()
  private readonly specId: string
  private readonly checkpointFile?: string
  private readonly specDigest?: string
  private readonly workspaceDigest?: string

  constructor(specId: string, checkpointDir?: string, freshness?: ResultStoreFreshness) {
    // M12: reject path-escape spec ids before any checkpoint file is formed
    // (both the constructor's join and restore()'s fallback join).
    if (!isSafeSpecId(specId)) {
      throw new Error(
        `workflow: specId "${specId}" is not a valid checkpoint identifier (must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$)`,
      )
    }
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

  /** Incremental checkpoint write (best-effort, atomic).
   *  M13: the target is replaced via temp + fsync + rename — a crash or
   *  disk error mid-write can never truncate the checkpoint; the previous
   *  generation survives until the new one is fully on disk. Failures are
   *  observable (warned), never silent. */
  private persist(): void {
    if (!this.checkpointFile) return
    const target = this.checkpointFile
    const tmp = `${target}.tmp`
    try {
      const data: CheckpointData = {
        specId: this.specId,
        updatedAt: Date.now(),
        specDigest: this.specDigest,
        workspaceDigest: this.workspaceDigest,
        results: [...this.results.values()],
      }
      mkdirSync(dirname(target), { recursive: true })
      const fd = openSync(tmp, "w")
      try {
        writeSync(fd, `${JSON.stringify(redactForTrace(data), null, 2)}\n`, null, "utf-8")
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, target)
    } catch (error) {
      // M13: observable — a silent checkpoint failure would later replay
      // stale results (or re-execute committed side effects) on restore.
      console.warn(`workflow: checkpoint write failed for "${this.specId}": ${error instanceof Error ? error.message : String(error)}`)
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
    } catch (error) {
      // M13: a corrupted checkpoint is observable (warned) and never
      // partially applied — the file itself is left untouched (the atomic
      // writer never produces truncated generations).
      console.warn(`workflow: checkpoint restore failed for "${this.specId}": ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }
}
