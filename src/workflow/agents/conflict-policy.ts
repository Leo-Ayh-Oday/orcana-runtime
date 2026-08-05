/** MACP-M5: conflict policy — same-file patch comparison.
 *
 *  - identical patches on the same file are deduplicated (task 5) and are
 *    NOT conflicts;
 *  - different patches on the same file produce a FileConflict (task 6:
 *    never auto-overwritten);
 *  - a file touched by one agent only (or identical across agents) can be
 *    auto-integrated (task 3);
 *  - symbol-level conflicts are derived from file conflicts (a same-file
 *    divergence is by definition a symbol-space collision); contract-level
 *    conflicts are declared explicitly via outputs (task 4/12 surface).
 */

import type { AgentResultBundle } from "./merge-bundle"

export interface FileConflict {
  file: string
  agents: string[]
  /** Distinct patch contents (deduplicated). */
  patches: string[]
}

export interface SymbolConflict {
  symbol: string
  file: string
  agents: string[]
}

export interface ContractConflict {
  contract: string
  agents: string[]
}

export interface ConflictSet {
  fileConflicts: FileConflict[]
  symbolConflicts: SymbolConflict[]
  contractConflicts: ContractConflict[]
}

export function emptyConflictSet(): ConflictSet {
  return { fileConflicts: [], symbolConflicts: [], contractConflicts: [] }
}

/** Content hash for patch dedup. */
function patchKey(content: string): string {
  let hash = 2166136261
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

/** Build the conflict set over the combined bundles. Deterministic:
 *  the result does not depend on bundle input order (agents sorted). */
export function buildConflictSet(bundles: AgentResultBundle[]): ConflictSet {
  const byFile = new Map<string, Array<{ agentId: string; patches: string[] }>>()
  for (const bundle of bundles) {
    for (const [file, agentIds] of Object.entries(bundle.files)) {
      if (!agentIds.includes(bundle.agentId)) continue
      const entry = byFile.get(file) ?? []
      entry.push({ agentId: bundle.agentId, patches: bundle.patches[file] ?? [] })
      byFile.set(file, entry)
    }
  }

  const fileConflicts: FileConflict[] = []
  const symbolConflicts: SymbolConflict[] = []
  const contractConflicts: ContractConflict[] = []

  for (const [file, writersRaw] of byFile) {
    if (writersRaw.length < 2) continue // single writer → auto-integrate
    const writers = [...writersRaw].sort((a, b) => (a.agentId < b.agentId ? -1 : 1))
    const agents = writers.map(w => w.agentId)
    // Task 5: identical patches deduplicate — no conflict.
    const distinct = new Set<string>()
    for (const writer of writers) {
      for (const patch of writer.patches) distinct.add(patchKey(patch))
    }
    if (distinct.size === 1) continue
    // Task 6: different patches — conflict, never auto-overwritten.
    const patches = [...new Set(writers.flatMap(w => w.patches))]
    fileConflicts.push({ file, agents, patches })
    symbolConflicts.push({ symbol: file, file, agents })
  }

  // Declared contract collisions: bundle.outputs["contracts"] overlap.
  const declared = new Map<string, Set<string>>()
  for (const bundle of bundles) {
    const contracts = bundle.outputs["contracts"]
    if (!Array.isArray(contracts)) continue
    for (const contract of contracts) {
      if (typeof contract !== "string") continue
      const set = declared.get(contract) ?? new Set<string>()
      set.add(bundle.agentId)
      declared.set(contract, set)
    }
  }
  for (const [contract, agentSet] of declared) {
    if (agentSet.size > 1) {
      contractConflicts.push({ contract, agents: [...agentSet].sort() })
    }
  }

  return { fileConflicts, symbolConflicts, contractConflicts }
}

/** Whether the conflict set blocks integration. */
export function hasConflicts(set: ConflictSet): boolean {
  return set.fileConflicts.length > 0 || set.symbolConflicts.length > 0 || set.contractConflicts.length > 0
}
