/** MACP-M3: per-node execution context — assignment + workspace resolution.
 *
 *  The workflow run resolves each node's participant assignment once at
 *  launch. Write nodes with an assignment execute inside the agent's
 *  worktree (their relative paths resolve against it); when the worktree
 *  cannot be created, write nodes fail closed (no silent degradation to the
 *  shared workspace — MACP-M3 task 12), while read-only nodes keep the
 *  shared workspace. Worktrees created by a run are disposed when the run
 *  finishes; leftovers are detectable for crash recovery.
 */

import type { ParticipantAssignment } from "./assignment"
import { createWorktree, type WorktreeHandle, worktreeRoot } from "./worktree"
import type { WorkflowNodeSpec } from "../types"
import type { WorkflowHarnessRuntime } from "../harness/node-context-factory"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

/** Resolved per-node enforcement context (M3 task 1/2/3). */
export interface WorkflowNodeExecutionContext {
  node: WorkflowNodeSpec
  /** Participant assignment, or null (no pool / no agent → legacy). */
  assignment: ParticipantAssignment | null
  /** Project root this node's relative paths resolve against: the agent's
   *  worktree root for assigned write nodes, the shared project otherwise. */
  projectRoot: string
  /** Whether this node is a write-class node. */
  isWrite: boolean
  /** Worktree handle owned by this node's execution (disposed at run end). */
  worktree?: WorktreeHandle
}

/** Worktrees created during a run, keyed by agent; disposed together at
 *  run end. Reuse: consecutive write nodes of the same agent share one
 *  worktree so earlier writes are not lost. */
export interface WorktreeRegistry {
  byAgent: Map<string, WorktreeHandle>
  dispose(): void
}

export function createWorktreeRegistry(): WorktreeRegistry {
  const byAgent = new Map<string, WorktreeHandle>()
  return {
    byAgent,
    dispose() {
      for (const handle of byAgent.values()) {
        try {
          handle.dispose()
        } catch {
          // best-effort cleanup
        }
      }
      byAgent.clear()
    },
  }
}

/** Identify leftover worktrees from crashed runs (M3 task 14). */
export function detectLegacyWorktrees(projectRoot: string): string[] {
  const base = join(projectRoot, ".orcana", "worktrees")
  if (!existsSync(base)) return []
  return readdirSync(base)
    .map(name => join(base, name))
    .filter(p => existsSync(p))
}

/** Ensure the agent's worktree exists (reused per agent); write nodes fail
 *  closed when the worktree cannot be prepared (no shared-workspace
 *  degradation for writes). Read-only nodes pass the shared project root
 *  through. */
export function prepareNodeWorkspace(
  runtime: WorkflowHarnessRuntime,
  node: WorkflowNodeSpec,
  assignment: ParticipantAssignment | null,
  isWrite: boolean,
  registry: WorktreeRegistry,
  pool?: import("./agent-pool").AgentPool,
): { projectRoot: string; worktree?: WorktreeHandle; denied?: string } {
  if (!assignment) {
    return { projectRoot: runtime.scope.projectRoot }
  }
  // Reads never need the worktree: shared workspace is fine.
  if (!isWrite) {
    return { projectRoot: runtime.scope.projectRoot }
  }
  const existing = registry.byAgent.get(assignment.agentId)
  if (existing) {
    return { projectRoot: existing.root, worktree: existing }
  }
  const projectRoot = runtime.scope.projectRoot
  const root = assignment.worktree
  try {
    const handle = createWorktree(projectRoot, assignment.agentId, assignment.ownerFiles)
    registry.byAgent.set(assignment.agentId, handle)
    return { projectRoot: handle.root, worktree: handle }
  } catch (error) {
    // Worktree creation failed → write must NOT degrade to the shared
    // workspace (task 12): fail the node with a structured reason.
    return { projectRoot, denied: error instanceof Error ? error.message : String(error) }
  }
}
