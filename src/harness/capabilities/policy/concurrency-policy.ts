/** Tool Runtime 2.0 (RT-5): concurrency policy — declared per-group caps for
 *  concurrent capability executions (readonly parallelism is safe; writes and
 *  external actions are serialized by default). The node runtime scheduler
 *  consults this; loop mode keeps its own batch semantics.
 */

export interface ConcurrencyPolicy {
  group: string
  maxConcurrent: number
}

/** Groups that must never run concurrently by default. */
export const SERIAL_GROUPS: ReadonlySet<string> = new Set(["write", "external"])

export function concurrencyPolicyFor(group: string, declaredMax?: number): ConcurrencyPolicy {
  if (declaredMax !== undefined) return { group, maxConcurrent: declaredMax }
  // Writes and external actions serialize; everything else is unlimited.
  return { group, maxConcurrent: SERIAL_GROUPS.has(group) ? 1 : Number.MAX_SAFE_INTEGER }
}

export interface ConcurrencyCheck {
  allowed: boolean
  message?: string
}

export function checkConcurrency(
  group: string,
  activeCount: number,
  declaredMax?: number,
): ConcurrencyCheck {
  const policy = concurrencyPolicyFor(group, declaredMax)
  if (activeCount >= policy.maxConcurrent) {
    return {
      allowed: false,
      message: `concurrency group "${group}" is saturated (${activeCount}/${policy.maxConcurrent} active)`,
    }
  }
  return { allowed: true }
}
