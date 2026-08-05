/** Tool Runtime 2.0 (RT-5): approval policy — how a permission gate decision
 *  maps to allow/block in each permission mode.
 *
 *  Rules (plan §5 RT-5):
 *    - deny always hard-blocks;
 *    - ask in strict mode hard-blocks (no interactive channel → fail closed);
 *    - ask in full mode is promoted to allow — Risk 4-5 promotion is then
 *      rejected by the risk gate (priority 8, per-invocation confirmation)
 *      and is never session-wide allowable (isSessionAllowableRisk).
 *  This preserves the gate ORDER: high-risk confirmation is the risk gate's
 *  job (it fires last so more specific gates win their blocking reasons).
 */

export interface ApprovalDecision {
  /** true → proceed; false → hard block. */
  allowed: boolean
  /** Why, when blocked. */
  reason?: string
}

export function approvalDecision(params: {
  gateLevel: "allow" | "ask" | "deny"
  permissionMode: "full" | "strict"
  riskLevel: number
}): ApprovalDecision {
  if (params.gateLevel === "allow") return { allowed: true }
  if (params.gateLevel === "deny") {
    return { allowed: false, reason: "permission:deny" }
  }
  // ask
  if (params.permissionMode === "strict") {
    return { allowed: false, reason: "permission:ask:strict" }
  }
  // full mode: promote ask → allow; the risk gate owns Risk 4-5.
  void params.riskLevel
  return { allowed: true }
}

export function formatApprovalBlockReason(gateLevel: "ask" | "deny", permissionMode: "full" | "strict"): string {
  if (gateLevel === "deny") return "permission:deny"
  return "permission:ask:strict"
}
