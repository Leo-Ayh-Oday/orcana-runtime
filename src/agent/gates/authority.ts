/**
 * Gate Authority Taxonomy (IC05).
 *
 * 三种 authority class：
 *  - hard:      保护明确现实 invariant 的机制，可以立即阻止现实动作。
 *  - advisory:  semantic/heuristic 机制，只能提示/排序/推荐/计 telemetry，
 *               不得永久 remove write tools / allowed=false / 无限 retry loop。
 *  - obligation:允许先执行，但 DONE 前必须由现实证据偿还。
 *
 * 本 registry 是 IC05 的权威分类，并有测试证明 classification 与真实
 * 行为一致（tests/ic05_gate_authority.test.ts）。
 */

export type GateAuthorityClass = "hard" | "advisory" | "obligation"

/** IC05 边界内的 gate authority 分类（不需要全历史代码一次性迁移）。 */
export const GATE_AUTHORITY_CLASSIFICATION: Record<string, GateAuthorityClass> = {
  // ── Hard Gates：现实 invariant，不得弱化 ──
  permission: "hard",
  path: "hard",
  context_budget: "hard",
  readonly_user_intent: "hard",
  destructive_risk: "hard",
  completion_evidence: "hard",

  // ── Advisory：启发式，无无限阻断权 ──
  context_readiness: "advisory",
  planning_quality: "advisory",
  tool_disclosure: "advisory",
  heuristic_ripple: "advisory",
  quality_reasoning: "advisory",

  // ── Obligation：先执行、DONE 前由现实证据偿还 ──
  context_debt: "obligation",
  ripple_obligation: "obligation",
  required_verification: "obligation",
}

export function authorityClassOf(gate: string): GateAuthorityClass | undefined {
  return GATE_AUTHORITY_CLASSIFICATION[gate]
}

/** 仅 hard gates 拥有现实阻断权。 */
export function isHardGate(gate: string): boolean {
  return GATE_AUTHORITY_CLASSIFICATION[gate] === "hard"
}

/** advisory 不得硬阻断（helper，供断言/审计使用）。 */
export function isAdvisory(gate: string): boolean {
  return GATE_AUTHORITY_CLASSIFICATION[gate] === "advisory"
}

export function isObligation(gate: string): boolean {
  return GATE_AUTHORITY_CLASSIFICATION[gate] === "obligation"
}
