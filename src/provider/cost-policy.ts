import type { ProviderCallPurpose } from "./types"

export type CostMode = "normal" | "strict"

const STRICT_DISABLED_PURPOSES = new Set<ProviderCallPurpose>([
  "chat_lite",
  "thinking_compaction",
  "semantic_recall_score",
  "knowledge_distill",
  "flash_triage",
  "completion_judge",
  "plan_judge",
  "ambiguity_detector",
  "cold_memory_audit",
])

export function currentCostMode(): CostMode {
  return process.env.ORCANA_COST_MODE === "strict" ? "strict" : "normal"
}

export function isStrictCostMode(): boolean {
  return currentCostMode() === "strict"
}

export function shouldSkipProviderPurpose(purpose: ProviderCallPurpose): boolean {
  return isStrictCostMode() && STRICT_DISABLED_PURPOSES.has(purpose)
}

export function formatSkippedProviderPurpose(purpose: ProviderCallPurpose): string {
  return `cost-mode strict: skipped ${purpose}`
}
