/** Conflict detection (G7): two agents writing the same file.
 *
 *  Ownership should prevent this statically; conflict detection is the
 *  dynamic backstop over actual write results — it compares file
 *  fingerprints so a conflict report carries evidence, not blame.
 */

import type { WorkflowNodeResult } from "../types"

export interface ConflictEntry {
  file: string
  agents: string[]
  /** Fingerprint per agent (content hash of what they wrote). */
  fingerprints: Array<{ agentId: string; fingerprint: string }>
}

export interface ConflictReport {
  conflicts: ConflictEntry[]
}

/** Extract agentId from a node id like "a1:w:patch" → "a1". */
export function agentOfNode(nodeId: string): string | null {
  const match = /^([^:]+):/.exec(nodeId)
  return match ? match[1]! : null
}

const SIMPLE_HASH = (input: string): string => {
  let hash = 2166136261
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

/** Detect same-file writes across agents from node results.
 *
 *  Looks at write-node outputs that declare written files (metadata.paths).
 *  Returns a structured conflict report. */
export function detectConflicts(results: WorkflowNodeResult[]): ConflictReport {
  const writesByFile = new Map<string, Array<{ agentId: string; fingerprint: string }>>()
  for (const result of results) {
    if (result.status !== "done") continue
    const agentId = agentOfNode(result.nodeId)
    if (!agentId) continue
    const output = result.output as { metadata?: { paths?: string[] } } | null
    const paths = output?.metadata?.paths
    if (!Array.isArray(paths)) continue
    const content = typeof output === "object" && output !== null ? JSON.stringify(output) : String(output)
    const fingerprint = SIMPLE_HASH(content)
    for (const path of paths) {
      const list = writesByFile.get(path)
      if (list) list.push({ agentId, fingerprint })
      else writesByFile.set(path, [{ agentId, fingerprint }])
    }
  }

  const conflicts: ConflictEntry[] = []
  for (const [file, writers] of writesByFile) {
    const agents = [...new Set(writers.map(w => w.agentId))]
    if (agents.length > 1) {
      conflicts.push({ file, agents, fingerprints: writers })
    }
  }
  return { conflicts }
}
