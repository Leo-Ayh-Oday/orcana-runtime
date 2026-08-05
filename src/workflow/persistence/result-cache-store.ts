/** Result cache persistence (G5): best-effort disk round-trip.
 *
 *  Same policy as G1 checkpoints: redactForTrace before writing, never
 *  fail the caller on I/O errors.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { dirname } from "node:path"
import { redactForTrace } from "../../agent/secret-redactor"
import { ResultCache, type CacheEntry } from "../results/result-cache"

export interface ResultCacheFile {
  schema: "orcana.result-cache"
  version: 1
  updatedAt: number
  entries: Record<string, CacheEntry>
}

export function saveResultCache(cache: ResultCache, file: string): boolean {
  try {
    const data: ResultCacheFile = {
      schema: "orcana.result-cache",
      version: 1,
      updatedAt: Date.now(),
      entries: cache.snapshot(),
    }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(redactForTrace(data), null, 2)}\n`, "utf-8")
    return true
  } catch {
    return false
  }
}

export function loadResultCache(file: string): ResultCache | null {
  try {
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as ResultCacheFile
    if (parsed.schema !== "orcana.result-cache") return null
    const cache = new ResultCache()
    cache.restoreEntries(parsed.entries)
    return cache
  } catch {
    return null
  }
}
