/** RunCancellation (H3 bridge → H4 policy).
 *
 *  createRunCancellation bridges the run's AbortController into the contract.
 *  createRunCancellationWithTimeout adds a wall-time watchdog: when the
 *  timeout fires the run is cancelled with the explicit wall_time_budget
 *  reason, so a stuck run always terminates even without event activity.
 */

import type { RunCancellation } from "../contracts/scope"

/** RunCancellation bridging the run's AbortController (H4 adds policy). */
export function createRunCancellation(controller: AbortController): RunCancellation {
  return {
    get signal() {
      return controller.signal
    },
    get cancelled() {
      return controller.signal.aborted
    },
    get reason() {
      return controller.signal.reason === undefined ? undefined : String(controller.signal.reason)
    },
    cancel(reason: string) {
      if (!controller.signal.aborted) controller.abort(reason)
    },
    throwIfCancelled() {
      if (controller.signal.aborted) {
        throw new Error(`Run cancelled: ${String(controller.signal.reason ?? "")}`)
      }
    },
  }
}

export interface TimedCancellation {
  cancellation: RunCancellation
  /** Clear the watchdog timer. Must be called when the run finishes. */
  dispose(): void
}

/** RunCancellation with a wall-time watchdog (cancels with wall_time_budget). */
export function createRunCancellationWithTimeout(
  controller: AbortController,
  wallTimeMs: number,
): TimedCancellation {
  const cancellation = createRunCancellation(controller)
  const timer = wallTimeMs < Number.MAX_SAFE_INTEGER
    ? setTimeout(() => cancellation.cancel("wall_time_budget"), wallTimeMs)
    : undefined
  return {
    cancellation,
    dispose() {
      if (timer) clearTimeout(timer)
    },
  }
}
