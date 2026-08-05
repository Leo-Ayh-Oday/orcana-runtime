/** MACP-M7: role assignments + authority baselines.
 *
 *  Planner / Coder / Reviewer roles map onto pool agents WITHOUT new
 *  execution machinery — the existing scheduler constraints (M3 writable,
 *  ownership, worktrees) already enforce the write side; this module
 *  encodes the role baselines and the separation rules:
 *    - a Coder can never be its own (only) Reviewer (task 9, SELF_APPROVAL);
 *    - reviewers may not merge or write (ROLE_AUTHORITY_LEAK: 0);
 *    - planners may not write nor approve their own plan.
 */

import type { WorkflowNodeSpec } from "../types"
import type { WorkflowRole } from "./role-contracts"

/** Role of a workflow node — explicit `role` field or derived from the
 *  handler/execution kind. Defaults to coder for write/tool nodes and
 *  reviewer for verification/merge nodes, planner for plan-producing nodes. */
export function roleOfNode(node: WorkflowNodeSpec): WorkflowRole {
  const explicit = (node.input as { role?: WorkflowRole }).role
  if (explicit === "planner" || explicit === "coder" || explicit === "reviewer") return explicit
  const execution = node.execution?.kind
  if (execution === "human") return "reviewer"
  if (execution === "verification") return "reviewer"
  if (node.handler === "reduce.merge_agents") return "reviewer"
  if (node.handler.startsWith("planner.") || node.handler.includes("plan")) return "planner"
  return "coder"
}

export interface RoleAssignment {
  nodeId: string
  role: WorkflowRole
  agentId: string
}

/** Collect role assignments from a spec (agent via node.assignment or id
 *  prefix). Nodes without an agent are unassigned. */
export function collectRoleAssignments(nodes: WorkflowNodeSpec[]): RoleAssignment[] {
  const assignments: RoleAssignment[] = []
  for (const node of nodes) {
    const agentId = node.assignment ?? /^([^:]+):/.exec(node.id)?.[1]
    if (!agentId) continue
    assignments.push({ nodeId: node.id, role: roleOfNode(node), agentId })
  }
  return assignments
}

export interface RoleSeparationViolation {
  task: string
  coder: string
  reviewer: string
  reason: string
}

/** Task 9: a coder may never be the (only) reviewer of its own output. */
export function validateRoleSeparation(assignments: RoleAssignment[]): { ok: boolean; violations: RoleSeparationViolation[] } {
  const violations: RoleSeparationViolation[] = []
  const coderAgents = new Set(assignments.filter(a => a.role === "coder").map(a => a.agentId))
  const reviewerAgents = new Set(assignments.filter(a => a.role === "reviewer").map(a => a.agentId))

  for (const coder of coderAgents) {
    if (reviewerAgents.has(coder)) {
      violations.push({
        task: "default",
        coder,
        reviewer: coder,
        reason: `coder "${coder}" is also a reviewer of its own output`,
      })
    }
  }
  return { ok: violations.length === 0, violations }
}

/** Authority baseline (permission matrix from the plan). */
export interface RoleAuthority {
  canWrite: boolean
  canMerge: boolean
  canApproveOwn: boolean
}

export const ROLE_AUTHORITY: Record<WorkflowRole, RoleAuthority> = {
  planner: { canWrite: false, canMerge: false, canApproveOwn: false },
  coder: { canWrite: true, canMerge: false, canApproveOwn: false },
  reviewer: { canWrite: false, canMerge: false, canApproveOwn: false },
}

/** Whether a node's declared execution violates its role's authority
 *  (e.g. a reviewer node that writes, a planner that merges). */
export function roleAuthorityViolation(role: WorkflowRole, node: WorkflowNodeSpec, isWrite: boolean): string | undefined {
  const authority = ROLE_AUTHORITY[role]
  if (isWrite && !authority.canWrite) {
    return `role "${role}" cannot write (node "${node.id}")`
  }
  if (node.handler === "reduce.merge_agents" && !authority.canMerge) {
    return `role "${role}" cannot merge (node "${node.id}")`
  }
  return undefined
}
