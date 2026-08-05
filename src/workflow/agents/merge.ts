/** Merge node (G7) — MACP-M5: 冲突安全合并.
 *
 *  reduce.merge_agents combines structured per-agent results WITHOUT
 *  field overwriting (later-wins is removed from the production path):
 *  outputs are isolated per agent; identical values deduplicate; differing
 *  values for the same key are reported as conflicts and never silently
 *  overwritten. Same-file touches are reported structurally.
 */

export interface AgentArtifact {
  agentId: string
  /** Structured artifact produced by the agent. */
  artifact: unknown
  /** Files the artifact touches (for conflict reporting). */
  files?: string[]
}

export interface MergeResult {
  /** Field-safe merge: identical values deduplicated, differing values
   *  never overwritten — they surface in `conflicts` instead. */
  merged: Record<string, unknown>
  conflicts: Array<{ file: string; agents: string[] }>
  /** Differing values for the same output key (M5: no later-wins). */
  valueConflicts: Array<{ key: string; agents: string[]; values: unknown[] }>
}

const VALUE_KEY = (value: unknown): string => {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Deterministic, conflict-safe merge (MACP-M5): identical values are
 *  deduplicated; differing values for the same key become valueConflicts
 *  instead of overwriting (later-wins removed). */
export function mergeAgentArtifacts(input: { agents?: AgentArtifact[] }): MergeResult {
  const agents = [...(input.agents ?? [])].sort((a, b) => (a.agentId < b.agentId ? -1 : 1))
  const merged: Record<string, unknown> = {}
  const conflicts: Array<{ file: string; agents: string[] }> = []
  const valueConflicts: Array<{ key: string; agents: string[]; values: unknown[] }> = []

  const valuesByKey = new Map<string, Array<{ agentId: string; value: unknown }>>()
  for (const entry of agents) {
    const artifact = entry.artifact
    if (artifact && typeof artifact === "object" && !Array.isArray(artifact)) {
      for (const [key, value] of Object.entries(artifact as Record<string, unknown>)) {
        const list = valuesByKey.get(key) ?? []
        list.push({ agentId: entry.agentId, value })
        valuesByKey.set(key, list)
      }
    }
  }
  for (const [key, list] of valuesByKey) {
    const distinct = new Map<string, unknown>()
    for (const item of list) distinct.set(VALUE_KEY(item.value), item.value)
    if (distinct.size === 1) {
      merged[key] = list[0]!.value // identical → dedupe, keep once
    } else {
      valueConflicts.push({
        key,
        agents: list.map(i => i.agentId).sort(),
        values: [...distinct.values()],
      })
    }
  }

  const touchedByFile = new Map<string, Set<string>>()
  for (const entry of agents) {
    for (const file of entry.files ?? []) {
      const set = touchedByFile.get(file)
      if (set) set.add(entry.agentId)
      else touchedByFile.set(file, new Set([entry.agentId]))
    }
  }
  for (const [file, agentSet] of touchedByFile) {
    if (agentSet.size > 1) conflicts.push({ file, agents: [...agentSet].sort() })
  }
  return { merged, conflicts, valueConflicts }
}

export const MERGE_AGENTS_HANDLER = {
  id: "reduce.merge_agents",
  description: "merge structured artifacts from multiple agents (deterministic, conflict-safe: no field overwriting; differing values reported as conflicts)",
}
