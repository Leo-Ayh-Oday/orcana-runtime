/** MACP-M5: agent result bundles — per-agent, field-isolated results.
 *
 *  Every agent's outputs are kept under its own agentId key (task 1:
 *  results saved independently per agent, NO field overwriting). Patches
 *  are keyed by file; evidence by file; files map file → writer agents.
 */

export interface AgentResultBundle {
  agentId: string
  /** Structured outputs, keyed by output name — never merged across agents
   *  (task 2: 禁止字段覆盖). */
  outputs: Record<string, unknown>
  /** file → patch content list (what this agent wrote to each file). */
  patches: Record<string, string[]>
  /** file → evidence ids this agent bound to the file. */
  evidence: Record<string, string[]>
  /** file → writer agents (this bundle's agent is one of them). */
  files: Record<string, string[]>
}

export interface CollectBundleInput {
  agentId: string
  /** Structured outputs produced by the agent (node output or artifact). */
  outputs?: Record<string, unknown>
  /** Files this agent wrote (project-relative). */
  files: string[]
  /** Read the agent's written content (from its worktree). */
  readFile: (relativePath: string) => string | undefined
  /** Evidence ids bound to this agent's writes. */
  evidenceByFile?: Record<string, string[]>
}

export function collectAgentBundle(input: CollectBundleInput): AgentResultBundle {
  const patches: Record<string, string[]> = {}
  const evidence: Record<string, string[]> = {}
  const files: Record<string, string[]> = {}
  for (const file of [...new Set(input.files)]) {
    const content = input.readFile(file)
    patches[file] = [content ?? ""]
    evidence[file] = input.evidenceByFile?.[file] ?? []
    files[file] = [input.agentId]
  }
  return {
    agentId: input.agentId,
    outputs: input.outputs ?? {},
    patches,
    evidence,
    files,
  }
}

/** Merge the per-agent bundle lists into one bundle set (deterministic
 *  order: agents sorted by id). */
export function combineBundles(bundles: AgentResultBundle[]): AgentResultBundle[] {
  return [...bundles].sort((a, b) => (a.agentId < b.agentId ? -1 : 1))
}
