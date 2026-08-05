/** Tool Runtime 2.0 (RT-5): risk policy — Risk 4-5 tools require
 *  per-invocation confirmation and are never session-wide allowed.
 *
 *  Fires LAST in the chain (priority 8) so more specific gates win their
 *  blocking reasons; only applies in "full" permission mode where ask→allow
 *  promotion would otherwise have let a high-risk tool through (Gate 2).
 */

import type { ToolDescriptor } from "../../../tools/registry"
import { getToolRisk, isHighRisk, formatRiskBlockMessage, type RiskLevel } from "../../../agent/tool-risk"

export { isHighRisk, formatRiskBlockMessage }
export type { RiskLevel }

export interface RiskGateDecision {
  reason: `tool_risk:${number}`
  blockMessage: string
  priority: 8
  riskLevel: number
}

export function highRiskConfirmationGate(
  tool: ToolDescriptor | undefined,
  input: Record<string, unknown>,
  permissionMode: "full" | "strict",
): RiskGateDecision | null {
  if (!tool) return null
  const risk = getToolRisk(tool.defn.name, input, tool)
  if (!isHighRisk(risk.level)) return null
  // Strict mode never reaches this gate: Gate 2 hard-blocks "ask" there.
  if (permissionMode !== "full") return null
  return {
    reason: `tool_risk:${risk.level}`,
    blockMessage: formatRiskBlockMessage(tool.defn.name, risk, input),
    priority: 8,
    riskLevel: risk.level,
  }
}

/** Risk 4-5 tools must never ride a session-wide allow (plan §5 RT-5). */
export function isSessionAllowableRisk(level: number): boolean {
  return level < 4
}
