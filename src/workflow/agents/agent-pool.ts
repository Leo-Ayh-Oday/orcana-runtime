/** Agent Pool (G7): T3R multi-agent — pool, ownership, cancellation.
 *
 *  An Agent is a named unit of work over an owned file set, running inside
 *  its own worktree, with its own budget and cancellable lifecycle. The pool
 *  enforces disjoint file ownership (two agents never write the same file),
 *  tracks cancellation so pending nodes fail fast, and hands out the
 *  per-agent budget.
 *
 *  Explicit API only — the pool has no effect unless a spec opts in.
 */

import { AgentBudget } from "./agent-budget"

export interface AgentSpec {
  id: string
  /** Files this agent owns (relative paths). Ownership is disjoint. */
  ownerFiles: string[]
  /** Worktree root for this agent's writes. */
  worktree: string
  /** MACP-M3: may this agent write at all? Planner/Reviewer default to
   *  false — they must not write the project workspace. */
  writable?: boolean
  budget?: { maxWrites?: number; maxNodes?: number }
}

export interface Agent {
  id: string
  /** Files this agent owns (relative paths). Ownership is disjoint. */
  ownerFiles: string[]
  /** Worktree root for this agent's writes. */
  worktree: string
  /** MACP-M3: false = this participant may never write (planner/reviewer). */
  writable: boolean
  cancelled: boolean
  budget: AgentBudget
}

export interface OwnershipViolation {
  agentId: string
  file: string
  alreadyOwnedBy: string
}

export interface RegisterResult {
  ok: boolean
  agent?: Agent
  violations?: OwnershipViolation[]
}

export class AgentPool {
  private readonly agents = new Map<string, Agent>()
  private readonly owners = new Map<string, string>()

  constructor() {}

  /** Register an agent; disjoint-ownership enforced. */
  register(spec: AgentSpec): RegisterResult {
    const violations: OwnershipViolation[] = []
    for (const file of spec.ownerFiles) {
      const owner = this.owners.get(file)
      if (owner && owner !== spec.id) {
        violations.push({ agentId: spec.id, file, alreadyOwnedBy: owner })
      }
    }
    if (violations.length > 0) {
      return { ok: false, violations }
    }
    for (const file of spec.ownerFiles) this.owners.set(file, spec.id)
    const agent: Agent = {
      ...spec,
      writable: spec.writable ?? true,
      cancelled: false,
      budget: new AgentBudget(spec.budget),
    }
    this.agents.set(spec.id, agent)
    return { ok: true, agent }
  }

  get(agentId: string): Agent | undefined {
    return this.agents.get(agentId)
  }

  list(): Agent[] {
    return [...this.agents.values()]
  }

  /** Owner of a file, or undefined when unowned. */
  ownerOf(file: string): string | undefined {
    return this.owners.get(file)
  }

  /** Ownership check for a write: the agent must own the file. */
  canWrite(agentId: string, file: string): boolean {
    const owner = this.owners.get(file)
    return owner !== undefined && owner === agentId
  }

  isCancelled(agentId: string): boolean {
    return this.agents.get(agentId)?.cancelled ?? false
  }

  /** Cancel an agent: pending nodes fail fast, running nodes abort. */
  cancel(agentId: string): boolean {
    const agent = this.agents.get(agentId)
    if (!agent) return false
    agent.cancelled = true
    return true
  }

  size(): number {
    return this.agents.size
  }
}
