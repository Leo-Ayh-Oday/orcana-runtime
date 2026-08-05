/** Failure signatures (G4): stable fingerprints for repair-loop convergence.
 *
 *  Two failures collapse to the same signature when their *error category*
 *  matches — phrasing differences never bypass dedupe (PR-G4 acceptance).
 *  The signature deliberately avoids raw message text: it is
 *  `handler | category`, where category comes from a finite regex whitelist.
 */

import type { WorkflowNodeResult } from "../types"

export const ERROR_CATEGORIES = [
  "patch_conflict",
  "missing_target",
  "process_failure",
  "permission_denied",
  "timeout",
  "unknown_handler",
  "missing_evidence",
  "unclassified",
] as const

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number]

/** Finite category whitelist — phrasing variants map to the same category. */
const CATEGORY_RULES: Array<[RegExp, ErrorCategory]> = [
  [/did not match|do not match|transaction rolled back|patch (rejected|failed)/i, "patch_conflict"],
  [/no such file|not found|does not exist|missing file/i, "missing_target"],
  [/exit code|non-zero|command failed|process (failed|exited)/i, "process_failure"],
  [/permission|not writable|read-only|EACCES/i, "permission_denied"],
  [/timeout|timed out/i, "timeout"],
  [/unknown handler|not found in runtime tool set/i, "unknown_handler"],
  [/no evidence|blocked_no_evidence/i, "missing_evidence"],
]

export function classifyError(message: string | undefined): ErrorCategory {
  if (!message) return "unclassified"
  for (const [rule, category] of CATEGORY_RULES) {
    if (rule.test(message)) return category
  }
  return "unclassified"
}

/** handler nodeId | category — stable across rewording of the error text. */
export function fingerprintFailure(result: WorkflowNodeResult): string {
  const category = classifyError(result.error)
  return `${result.nodeId}|${category}`
}
