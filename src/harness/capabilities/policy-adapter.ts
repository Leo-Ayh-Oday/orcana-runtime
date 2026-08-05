/** Policy adapter (H9): node-mode policy evaluation over the L4 chain.
 *
 *  The 8-layer gate order is NOT reimplemented — buildNodePolicyInput feeds
 *  the same evaluateToolPolicy pure function the loop uses (plan §15.3
 *  "Permission / Mode / Risk Policy" step), so policy ordering is frozen at
 *  the type level. Node mode has no round semantics, so round-scoped inputs
 *  take conservative defaults; H11 Node Runtime will enrich them from the
 *  node context.
 */

import type { ToolPolicyInput } from "../../agent/tool-execution/policy"
import type { PermissionGate, ToolCategory } from "../../agent/permission"
import type { ModeContract } from "../../agent/mode-contract"
import type { ToolDescriptor } from "../../tools/registry"

export interface NodePolicyContext {
  permissionGate: PermissionGate
  permissionMode?: "full" | "strict"
  modeContract?: ModeContract
  tool?: ToolDescriptor
  input: Record<string, unknown>
  toolCallId?: string
  /** Policy subject name when no tool descriptor is resolved (R1: name-only
   *  evaluation falls back to category inference, fail-closed in strict mode). */
  name?: string
  /** RT-5: writable-root boundary — node mode passes the run scope's
   *  projectRoot so write paths are checked against it. */
  projectRoot?: string
  writableRoots?: string[]
}

/** Node mode has no round semantics: the round-scoped Gate 1 caps compare
 *  per-round usage counters, so a standalone node call starts at zero —
 *  counters at Infinity would make EVERY call trip the cap (R1 found this:
 *  the old "unlimited" values saturated Gate 1). Run-level call budgets are
 *  governed by the BudgetLedger instead. */
const NODE_MODE_ROUND_USAGE: Record<ToolCategory, number> = {
  safe: 0,
  file: 0,
  network: 0,
  shell: 0,
  git: 0,
}

/** Assemble an L4 ToolPolicyInput for a standalone (node-mode) call. */
export function buildNodePolicyInput(context: NodePolicyContext): ToolPolicyInput {
  return {
    toolCall: {
      id: context.toolCallId ?? "node-call",
      name: context.name ?? context.tool?.defn.name ?? "unknown",
      input: context.input,
    },
    tool: context.tool,
    intentPolicy: { mode: "default", reason: "node-mode default" },
    taskTracker: null,
    rippleBlockActive: false,
    pendingRippleObligations: [],
    permissionGate: context.permissionGate,
    permissionMode: context.permissionMode ?? "strict",
    rateLimits: { ...NODE_MODE_ROUND_USAGE },
    webSearchFailedThisTurn: false,
    webSearchFailReason: "",
    finalText: "",
    modeContract: context.modeContract,
    projectRoot: context.projectRoot,
    writableRoots: context.writableRoots ?? (context.projectRoot ? [context.projectRoot] : undefined),
  }
}
