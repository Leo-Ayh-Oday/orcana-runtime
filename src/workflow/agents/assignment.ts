/** MACP-M3: participant assignment — node → agent resolution.
 *
 *  A node is assigned to a pool agent either explicitly (`node.assignment`)
 *  or by its id prefix ("a1:w:patch" → agent "a1", G7 convention). Without
 *  a pool, or when the node names no registered agent, there is no
 *  assignment and the scheduler behaves exactly as before
 *  (SINGLE_AGENT_REGRESSION: 0).
 */

import type { AgentPool, Agent } from "./agent-pool"

/** The enforcement surface for one node run. */
export interface ParticipantAssignment {
  agentId: string
  agent: Agent
  /** May this participant write at all (planner/reviewer = false). */
  canWrite: boolean
  /** Agent-owned files (relative paths, as declared). */
  ownerFiles: string[]
  /** Worktree root for this agent's writes. */
  worktree: string
}

/** G7: node ids like "a1:w:patch" map to pool agent "a1". */
export function agentIdOfNode(nodeId: string): string | null {
  const match = /^([^:]+):/.exec(nodeId)
  return match ? match[1]! : null
}

/** Resolve the assignment for a node, or undefined when none applies. */
export function resolveAssignment(node: { id: string; assignment?: string }, pool?: AgentPool): ParticipantAssignment | undefined {
  if (!pool) return undefined
  const agentId = node.assignment ?? agentIdOfNode(node.id)
  if (!agentId) return undefined
  const agent = pool.get(agentId)
  if (!agent) return undefined
  return {
    agentId,
    agent,
    canWrite: agent.writable,
    ownerFiles: agent.ownerFiles,
    worktree: agent.worktree,
  }
}
