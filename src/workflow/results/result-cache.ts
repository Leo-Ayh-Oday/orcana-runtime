/** Result cache (G5): read-node results keyed by input hash.
 *
 *  key = stableHashString({ handler, input }) — G0's stableHash consumed
 *  at last. Read nodes that finish `done` are stored; a write node
 *  completing successfully invalidates everything (superset invalidation:
 *  after a write, all read results are recomputed, satisfying "modified
 *  files invalidate related cache entries" without per-file tracking).
 *
 *  Replay: a cache hit returns the stored result; the scheduler marks it
 *  `replayed` (durationMs 0) and never re-executes the handler.
 */

import { stableHash } from "./result-hash"
import type { WorkflowNodeResult } from "../types"

export interface CacheEntry {
  inputHash: string
  result: WorkflowNodeResult
  cachedAt: number
}

export function cacheKeyFor(handler: string, input: Record<string, unknown>): string {
  return stableHash({ handler, input })
}

export class ResultCache {
  private readonly entries = new Map<string, CacheEntry>()
  hits = 0
  misses = 0
  invalidations = 0

  get(inputHash: string): CacheEntry | undefined {
    const entry = this.entries.get(inputHash)
    if (entry) this.hits++
    else this.misses++
    return entry
  }

  /** Store a completed read-node result (done only; failures never cached). */
  put(inputHash: string, result: WorkflowNodeResult): void {
    if (result.status !== "done") return
    this.entries.set(inputHash, { inputHash, result, cachedAt: Date.now() })
  }

  /** Superset invalidation after a write: all read results are recomputed. */
  invalidateAll(): void {
    this.entries.clear()
    this.invalidations++
  }

  size(): number {
    return this.entries.size
  }

  snapshot(): Record<string, CacheEntry> {
    return Object.fromEntries(this.entries)
  }

  restoreEntries(records: Record<string, CacheEntry> | undefined): void {
    if (!records) return
    for (const [key, entry] of Object.entries(records)) {
      if (entry && typeof entry.inputHash === "string" && entry.result?.nodeId) {
        this.entries.set(key, entry)
      }
    }
  }
}
