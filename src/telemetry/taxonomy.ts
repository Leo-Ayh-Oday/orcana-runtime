/** PR-10.1 — RunTrace event taxonomy.
 *
 *  Standardizes the free-form `RunTraceEvent.type` strings into a finite
 *  category set so traces are machine-queryable and unknown/new event types
 *  are discoverable instead of silently ignored.
 *
 *   lifecycle   — run/round/session start & terminal events
 *   model       — model selection, token usage, provider status
 *   tool        — tool calls and results
 *   gate        — deterministic gate decisions (policy/completion/planning/…)
 *   verification— verification runs and results
 *   evidence    — evidence ledger ingestion and invalidation
 *   workflow    — typed execution graph projection (G0+)
 *   error       — failures, aborts, blocks
 *   internal    — anything not yet classified (discoverability bucket)
 */

export const TRACE_EVENT_CATEGORIES = [
  "lifecycle",
  "model",
  "tool",
  "gate",
  "verification",
  "evidence",
  "workflow",
  "error",
  "internal",
] as const

export type TraceEventCategory = (typeof TRACE_EVENT_CATEGORIES)[number]

/** Known type → category mapping (prefix rules; first match wins).
 *  Specialized prefixes outrank the generic lifecycle suffixes so
 *  `verification_started` is verification, not lifecycle. */
const TAXONOMY_RULES: Array<[RegExp, TraceEventCategory]> = [
  [/^(workflow|graph|node|edge|scheduler)/, "workflow"],
  [/^verification/, "verification"],
  [/^evidence/, "evidence"],
  [/^tool_/, "tool"],
  [/^(gate|policy|completion|planning|plan|permission|ripple|mode_)/, "gate"],
  [/^(model|provider|token|cache|thinking|context)/, "model"],
  [/^(run|round|session)_|_finished$|_started$|aborted|terminated|rollover|resumed/, "lifecycle"],
  [/error|failed|blocked|quota/, "error"],
]

/** Classify a trace event type; unknown types land in `internal`. */
export function classifyTraceEvent(type: string): TraceEventCategory {
  for (const [rule, category] of TAXONOMY_RULES) {
    if (rule.test(type)) return category
  }
  return "internal"
}

/** Whether the type matches a known category (not `internal`). */
export function isKnownTraceEvent(type: string): boolean {
  return classifyTraceEvent(type) !== "internal"
}

/** Canonical, documented event types produced by the runtime. */
export const CANONICAL_TRACE_EVENTS: Record<TraceEventCategory, string[]> = {
  lifecycle: ["run_started", "run_finished", "run_aborted", "round_started", "round_finished", "epoch_rollover"],
  model: ["model_selected", "provider_status", "token_usage", "cache_prefix_shape", "thinking_decision"],
  tool: ["tool_call", "tool_result", "tool_blocked"],
  gate: ["gate_decision", "mode_transition", "plan_transition", "permission_decision"],
  verification: ["verification_started", "verification_result", "verification_blocked"],
  evidence: ["evidence_ingested", "evidence_invalidated", "evidence_stale"],
  workflow: ["workflow_started", "workflow_node_finished", "workflow_finished", "workflow_checkpoint"],
  error: ["error", "error_failed", "quota_blocked"],
  internal: ["<unclassified — file a taxonomy rule>"],
}

export interface TraceSummary {
  total: number
  byCategory: Record<TraceEventCategory, number>
  /** Types that did not match any known category. */
  unknownTypes: string[]
}

/** Aggregate a list of trace events into a category summary. */
export function summarizeTrace(events: Array<{ type: string }>): TraceSummary {
  const byCategory = Object.fromEntries(TRACE_EVENT_CATEGORIES.map(c => [c, 0])) as Record<TraceEventCategory, number>
  const unknownTypes = new Set<string>()
  for (const event of events) {
    const category = classifyTraceEvent(event.type)
    byCategory[category]++
    if (category === "internal") unknownTypes.add(event.type)
  }
  return { total: events.length, byCategory, unknownTypes: [...unknownTypes].sort() }
}

/** Canonical name for a category (for reports). */
export const CATEGORY_LABELS: Record<TraceEventCategory, string> = {
  lifecycle: "生命周期",
  model: "模型",
  tool: "工具",
  gate: "门禁",
  verification: "验证",
  evidence: "证据",
  workflow: "工作流图",
  error: "错误",
  internal: "未分类",
}
