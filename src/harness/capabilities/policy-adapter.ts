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
}

const UNLIMITED_RATE_LIMITS: Record<ToolCategory, number> = {
  safe: Number.POSITIVE_INFINITY,
  file: Number.POSITIVE_INFINITY,
  network: Number.POSITIVE_INFINITY,
  shell: Number.POSITIVE_INFINITY,
  git: Number.POSITIVE_INFINITY,
}

/** Assemble an L4 ToolPolicyInput for a standalone (node-mode) call. */
export function buildNodePolicyInput(context: NodePolicyContext): ToolPolicyInput {
  return {
    toolCall: {
      id: context.toolCallId ?? "node-call",
      name: context.tool?.defn.name ?? "unknown",
      input: context.input,
    },
    tool: context.tool,
    intentPolicy: { mode: "default", reason: "node-mode default" },
    taskTracker: null,
    rippleBlockActive: false,
    pendingRippleObligations: [],
    permissionGate: context.permissionGate,
    permissionMode: context.permissionMode ?? "strict",
    rateLimits: { ...UNLIMITED_RATE_LIMITS },
    webSearchFailedThisTurn: false,
    webSearchFailReason: "",
    finalText: "",
    modeContract: context.modeContract,
  }
}
