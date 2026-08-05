/** Agent budget (G7): per-agent caps — nodes, writes, verification rounds.
 *
 *  Exceeding a cap blocks THAT agent's subgraph (budget_exhausted) without
 *  affecting other agents in the pool.
 */

export interface AgentBudgetCaps {
  maxWrites?: number
  maxNodes?: number
}

export interface AgentBudgetState {
  nodes: number
  writes: number
}

export type BudgetVerdict = "ok" | "nodes_exhausted" | "writes_exhausted"

export class AgentBudget {
  private readonly caps: AgentBudgetCaps
  private state: AgentBudgetState = { nodes: 0, writes: 0 }

  constructor(caps?: AgentBudgetCaps) {
    this.caps = caps ?? {}
  }

  /** Register a node; returns a verdict when the cap would be exceeded. */
  chargeNode(): BudgetVerdict {
    if (this.caps.maxNodes !== undefined && this.state.nodes >= this.caps.maxNodes) {
      return "nodes_exhausted"
    }
    this.state.nodes++
    return "ok"
  }

  /** Register a write; returns a verdict when the cap would be exceeded. */
  chargeWrite(): BudgetVerdict {
    if (this.caps.maxWrites !== undefined && this.state.writes >= this.caps.maxWrites) {
      return "writes_exhausted"
    }
    this.state.writes++
    return "ok"
  }

  stateSnapshot(): AgentBudgetState {
    return { ...this.state }
  }

  exhausted(): boolean {
    return (
      (this.caps.maxNodes !== undefined && this.state.nodes >= this.caps.maxNodes) ||
      (this.caps.maxWrites !== undefined && this.state.writes >= this.caps.maxWrites)
    )
  }
}
