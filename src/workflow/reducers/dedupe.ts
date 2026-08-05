/** Deterministic reducers (G1): pure, hashable, parallel-safe.

 *  reduce.dedupe — dedupe an array of values (deep JSON equality via
 *    stableSerialize); keeps first occurrence order.
 *  reduce.merge_diagnostics — merge typecheck/diagnostic reports into one
 *    array, stable-sorted by (path, line).
 */

import { stableSerialize } from "../results/result-hash"

export function dedupeValues(values: unknown[]): unknown[] {
  const seen = new Set<string>()
  const out: unknown[] = []
  for (const value of values) {
    const key = stableSerialize(value)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}

export interface DiagnosticEntry {
  path?: string
  line?: number
  [key: string]: unknown
}

export function mergeDiagnostics(groups: Array<DiagnosticEntry[] | undefined>): DiagnosticEntry[] {
  const merged: DiagnosticEntry[] = []
  for (const group of groups) {
    if (Array.isArray(group)) merged.push(...group)
  }
  return merged.sort((a, b) => {
    const pathA = String(a.path ?? "")
    const pathB = String(b.path ?? "")
    if (pathA !== pathB) return pathA < pathB ? -1 : 1
    return (a.line ?? 0) - (b.line ?? 0)
  })
}
