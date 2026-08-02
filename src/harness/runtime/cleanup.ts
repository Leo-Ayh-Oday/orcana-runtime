/** Run cleanup (H2): the single, once-per-run release path.
 *
 *  Every exit — completed, waiting, blocked, paused, cancelled, failed —
 *  routes through cleanupRun(): detaches the run from its session and stops
 *  the cancellation controller so no resources outlive the run. The kernel's
 *  own resource cleanup (sandbox, ripple, patch, stop hook) is already
 *  handled by its unified `finally` (ALK L7) — this is the harness layer.
 */

import type { AgentSession } from "../contracts/session"

export interface RunCleanupInput {
  session: AgentSession
  runId: string
  controller: AbortController
}

export function cleanupRun(input: RunCleanupInput): void {
  const { session, runId, controller } = input
  session.activeRunIds = session.activeRunIds.filter(id => id !== runId)
  session.updatedAt = Date.now()
  // Guard: a run that ended without an explicit cancel decision (or whose
  // consumer closed early) must not keep its abort handle armed.
  if (!controller.signal.aborted) {
    try {
      controller.abort("run finished")
    } catch {
      // Best-effort.
    }
  }
}
