/** Merge node (G7): combine multiple agents' outputs.
 *
 *  reduce.merge_agents merges structured per-agent results into one payload
 *  with a deterministic ordering, and reports ownership conflicts when two
 *  agents produced results for the same target. Merge itself is a write
 *  handler so the merged artifact lands through the single-writer
 *  transaction path.
 */

export interface AgentArtifact {
  agentId: string
  /** Structured artifact produced by the agent. */
  artifact: unknown
  /** Files the artifact touches (for conflict reporting). */
  files?: string[]
}

export interface MergeResult {
  merged: Record<string, unknown>
  conflicts: Array<{ file: string; agents: string[] }>
}

/** Deterministic merge: later agents' artifacts win per key, conflicts are
 *  reported structurally (never silently dropped). */
export function mergeAgentArtifacts(input: { agents?: AgentArtifact[] }): MergeResult {
  const agents = input.agents ?? []
  const merged: Record<string, unknown> = {}
  const conflicts: Array<{ file: string; agents: string[] }> = []

  const touchedByFile = new Map<string, Set<string>>()
  for (const entry of agents) {
    const files = entry.files ?? []
    for (const file of files) {
      const set = touchedByFile.get(file)
      if (set) set.add(entry.agentId)
      else touchedByFile.set(file, new Set([entry.agentId]))
    }
    const artifact = entry.artifact
    if (artifact && typeof artifact === "object" && !Array.isArray(artifact)) {
      for (const [key, value] of Object.entries(artifact as Record<string, unknown>)) {
        merged[key] = value // later agent wins
      }
    }
  }
  for (const [file, agents] of touchedByFile) {
    if (agents.size > 1) conflicts.push({ file, agents: [...agents].sort() })
  }
  return { merged, conflicts }
}

export const MERGE_AGENTS_HANDLER = {
  id: "reduce.merge_agents",
  description: "merge structured artifacts from multiple agents (deterministic, later wins; conflicts reported structurally)",
}
