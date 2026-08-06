/** MACP-M3: scheduler-side enforcement context.
 *
 *  Per-node, at launch:
 *    1. resolve the participant assignment (explicit `node.assignment` or
 *       id-prefix; no pool → legacy behavior);
 *    2. pre-check the declared write path (normalized + owned) — denial
 *       fails the node with errorKind "ownership_denied";
 *    3. prepare the workspace — assigned write nodes run inside the
 *       agent's worktree (created on demand; creation failure fails the
 *       node, never a silent shared-workspace degradation); read-only
 *       nodes keep the shared workspace;
 *    4. post-check the actual written paths the tool reported (task 8/9).
 *  All worktrees created for the run are disposed when the run finishes.
 */

import type { WorkflowNodeSpec, WorkflowNodeResult } from "../types"
import type { AgentPool } from "../agents/agent-pool"
import { resolveAssignment, type ParticipantAssignment } from "../agents/assignment"
import { authorizeDeclaredWrite, verifyActualWrites, extractActualWritePaths } from "../agents/ownership-policy"
import { prepareNodeWorkspace, createWorktreeRegistry, type WorktreeRegistry, type WorkflowNodeExecutionContext } from "../agents/workspace-context"
import type { WorkflowHarnessRuntime } from "../harness/node-context-factory"

/** The declared write path of a node (params.path / input.path). */
export function declaredWritePath(node: WorkflowNodeSpec): string | undefined {
  const params = node.execution?.kind === "tool" ? node.execution.params : node.input
  const raw = (params as { path?: unknown }).path
  if (typeof raw === "string") return raw
  if (Array.isArray(raw)) {
    const first = raw.find(p => typeof p === "string")
    return typeof first === "string" ? first : undefined
  }
  return undefined
}

export interface NodeEnforcement {
  assignment: ParticipantAssignment | null
  projectRoot: string
  deniedReason?: string
}

/** Resolve + enforce the declared write for a node before it launches.
 *  Order: worktree first (execution root), then declared-path ownership
 *  against that root — a write that cannot reach a worktree is denied
 *  outright (task 12). */
export function enforceNodeAssignment(
  node: WorkflowNodeSpec,
  isWrite: boolean,
  runtime: WorkflowHarnessRuntime,
  pool: AgentPool | undefined,
  registry: WorktreeRegistry,
): NodeEnforcement {
  const assignment = resolveAssignment(node, pool)
  const projectRoot = runtime.scope.projectRoot

  // M1: an EXPLICIT assignment naming an unregistered agent must fail
  // closed — resolving it to "no participant" would let the write degrade
  // to the shared workspace (pool escape). Only the implicit id-prefix miss
  // keeps legacy behavior (G7: "r:1" is not an agent declaration).
  if (node.assignment && pool && !assignment) {
    return {
      assignment: null,
      projectRoot,
      deniedReason: `agent "${node.assignment}" is not registered in the pool (UNREGISTERED_ASSIGNMENT)`,
    }
  }

  // No pool / not a participant → legacy behavior (SINGLE_AGENT_REGRESSION).
  if (!assignment) {
    return { assignment: null, projectRoot }
  }

  // Writes: worktree, then pre-check ownership of the declared path.
  if (isWrite) {
    const declared = declaredWritePath(node)
    if (!declared) {
      return {
        assignment,
        projectRoot,
        deniedReason: `agent "${assignment.agentId}" write node "${node.id}" declares no path (UNOWNED_WRITE)`,
      }
    }
    const workspace = prepareNodeWorkspace(runtime, node, assignment, true, registry, pool)
    if (workspace.denied) {
      return {
        assignment,
        projectRoot,
        deniedReason: `worktree for agent "${assignment.agentId}" unavailable: ${workspace.denied} (write must not degrade to the shared workspace)`,
      }
    }
    const decision = authorizeDeclaredWrite(assignment, workspace.projectRoot, declared)
    if (!decision.allowed) {
      return { assignment, projectRoot: workspace.projectRoot, deniedReason: decision.reason }
    }
    return { assignment, projectRoot: workspace.projectRoot }
  }

  // Reads: shared workspace, assignment retained for context.
  return { assignment, projectRoot }
}

/** Post-write: verify the actual paths the tool reported. The enforcement
 *  root is the node's execution root (agent worktree or shared workspace);
 *  reported paths resolve against it (owner files are project-relative). */
export function enforceActualWrites(
  node: WorkflowNodeSpec,
  enforcement: NodeEnforcement,
  output: unknown,
): string | undefined {
  if (!enforcement.assignment) return undefined
  const actual = extractActualWritePaths(output)
  if (actual.length === 0) {
    return `agent "${enforcement.assignment.agentId}" write node "${node.id}" reported no actual write paths (missing metadata.paths)`
  }
  const verdict = verifyActualWrites(enforcement.assignment, enforcement.projectRoot, actual)
  if (!verdict.ok) {
    return `actual write paths violate ownership: ${verdict.violations.map(v => `${v.actual} (${v.reason})`).join("; ")}`
  }
  return undefined
}

/** Structured denial result (pre-launch). */
export function ownershipDeniedResult(nodeId: string, reason: string): WorkflowNodeResult {
  const now = Date.now()
  return {
    nodeId,
    status: "failed",
    output: null,
    error: `workflow: ownership_denied — ${reason}`,
    errorKind: "ownership_denied",
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
  }
}

export type { WorkflowNodeExecutionContext, WorktreeRegistry }
export { createWorktreeRegistry, resolveAssignment }
