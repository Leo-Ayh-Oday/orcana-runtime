/** MACP-M5: integration plan — automatic vs blocked files.
 *
 *  Files with a single writer (or identical patches across writers) go into
 *  `automatic` (task 3); the conflict set blocks everything else. The plan
 *  is order-independent by construction (sorted keys, sorted agents) — a
 *  conflict can never be resolved differently by reordering agents.
 */

import type { AgentResultBundle } from "./merge-bundle"
import { buildConflictSet, hasConflicts, type ConflictSet } from "./conflict-policy"

export interface IntegrationPlan {
  /** Files that can be auto-integrated (disjoint writes + deduped). */
  automatic: string[]
  conflictSet: ConflictSet
  bundles: AgentResultBundle[]
  /** Source agent per automatic file (deduped files pick the first agent). */
  sourceByFile: Record<string, string>
}

export function buildIntegrationPlan(bundles: AgentResultBundle[]): IntegrationPlan {
  const conflictSet = buildConflictSet(bundles)
  const blocked = new Set<string>(conflictSet.fileConflicts.map(c => c.file))
  const sourceByFile: Record<string, string> = {}
  const automatic = new Set<string>()

  for (const bundle of bundles) {
    for (const file of Object.keys(bundle.files)) {
      if (blocked.has(file) || automatic.has(file)) continue
      automatic.add(file)
      sourceByFile[file] = bundle.agentId
    }
  }

  return {
    automatic: [...automatic].sort(),
    conflictSet,
    bundles: [...bundles].sort((a, b) => (a.agentId < b.agentId ? -1 : 1)),
    sourceByFile,
  }
}

export function planBlocked(plan: IntegrationPlan): boolean {
  return hasConflicts(plan.conflictSet)
}
