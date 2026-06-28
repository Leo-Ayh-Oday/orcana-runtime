/** Gate Layer — three-layer boundary classification for the deterministic gate architecture.
 *
 *  PR-7.1: Gates are classified into three layers with distinct responsibilities
 *  and trace source prefixes. Every block has exactly ONE layer source.
 *
 *  Layer boundaries:
 *    hooks    — lifecycle interception + context injection only.
 *               Must NOT make blocking decisions about execution.
 *               Source prefix: "hooks:"
 *    policy   — deterministic allow/block decisions.
 *               rate_limit, permission, readonly_intent, mode_contract,
 *               tool_risk, sandbox, context_readiness, web_search_failed.
 *               No model calls, no semantic analysis.
 *               Source prefix: "policy:"
 *    semantic — model-assisted gates requiring LLM evaluation.
 *               planning, quality, flash_judge, evidence, truthfulness,
 *               ripple_exit, task_tracker, completion.
 *               May inject prompts, block completion, or signal plan_ready.
 *               Source prefix: "semantic:"
 *
 *  Design invariants:
 *    - Each block is traceable to exactly one layer + gate
 *    - Hooks may warn but the blocking decision belongs to policy or semantic
 *    - Pre-round filters (tool_disclosure, readonly_plan, ripple_tool_filter)
 *      are policy-layer: they narrow the tool set deterministically
 */

// ── Layer enum ──

export enum GateLayer {
  /** Lifecycle interception + context injection. Warn only — blocking
   *  decisions should be escalated to policy or semantic layer. */
  Hooks = "hooks",
  /** Deterministic allow/block — fast, synchronous, no model calls. */
  Policy = "policy",
  /** Model-assisted evaluation — planning, quality, completion, evidence. */
  Semantic = "semantic",
}

// ── Source classification ──

/** Map a gate source string (with layer prefix) to its GateLayer. */
export function classifyGateSource(source: string): GateLayer {
  if (source.startsWith("hooks:")) return GateLayer.Hooks
  if (source.startsWith("policy:")) return GateLayer.Policy
  if (source.startsWith("semantic:")) return GateLayer.Semantic
  // Legacy sources without prefix — classify by known names
  return classifyLegacySource(source)
}

/** Legacy fallback: classify sources that don't yet have layer prefixes. */
function classifyLegacySource(source: string): GateLayer {
  // Policy-layer legacy names
  if (/^(rate_limit|permission|readonly_intent|ripple_block|planning_phase|context_readiness|web_search_failed|mode_contract|tool_risk|tool_disclosure|readonly_plan|context_budget)$/.test(source)) {
    return GateLayer.Policy
  }
  // Hooks-layer legacy names
  if (/^(writeGuard|safety-policy|journalGuard|journalVeto)$/.test(source)) {
    return GateLayer.Hooks
  }
  // Semantic-layer legacy names
  if (/^(ripple_exit|planning|task_tracker|quality|flash_judge|evidence|truthfulness|planning_artifact|external_completion|master_plan)$/.test(source)) {
    return GateLayer.Semantic
  }
  // Unknown — treat as semantic by default (most conservative)
  return GateLayer.Semantic
}

// ── Source formatting ──

/** Format a layer-prefixed source string. */
export function formatLayerSource(layer: GateLayer, name: string): string {
  return `${layer}:${name}`
}

// ── Gate manifest ──

export interface GateManifestEntry {
  /** Full layer-prefixed gate name (e.g. "policy:rate_limit"). */
  name: string
  /** Which layer this gate belongs to. */
  layer: GateLayer
  /** Human-readable description of what this gate does. */
  description: string
  /** Whether this gate can block (true) or only filter/warn (false). */
  canBlock: boolean
  /** Approximate priority within the layer (lower = evaluated first). */
  priority: number
}

/** Complete manifest of all gates with layer classification.
 *
 *  This is the PR-7.1 boundary map — every block-producing gate is
 *  accounted for here with a single, unambiguous layer assignment. */
export const GATE_MANIFEST: GateManifestEntry[] = [
  // ── Hooks layer ──
  { name: "hooks:writeGuard", layer: GateLayer.Hooks, description: "Blocks writes to un-read files in strict mode", canBlock: true, priority: 10 },
  { name: "hooks:safety-policy", layer: GateLayer.Hooks, description: "Blocks dangerous shell commands, secret file access, out-of-project writes", canBlock: true, priority: 5 },
  { name: "hooks:journalGuard", layer: GateLayer.Hooks, description: "Journal iron-law veto on write operations", canBlock: true, priority: 15 },

  // ── Policy layer — tool execution ──
  { name: "policy:rate_limit", layer: GateLayer.Policy, description: "Per-category tool invocation cap per round", canBlock: true, priority: 1 },
  { name: "policy:permission", layer: GateLayer.Policy, description: "User permission gate (deny/ask/allow)", canBlock: true, priority: 2 },
  { name: "policy:readonly_intent", layer: GateLayer.Policy, description: "Blocks writes when user intent is readonly", canBlock: true, priority: 3 },
  { name: "policy:ripple_block", layer: GateLayer.Policy, description: "Blocks writes when ripple obligations are pending", canBlock: true, priority: 4 },
  { name: "policy:planning_phase", layer: GateLayer.Policy, description: "Blocks writes before plan is accepted in planning phase", canBlock: true, priority: 5 },
  { name: "policy:context_readiness", layer: GateLayer.Policy, description: "Blocks writes until enough project context is acquired", canBlock: true, priority: 6 },
  { name: "policy:web_search_failed", layer: GateLayer.Policy, description: "Blocks web_search when the backend is unavailable", canBlock: true, priority: 7 },
  { name: "policy:mode_contract", layer: GateLayer.Policy, description: "Enforces allowedTools/forbiddenTools per active mode", canBlock: true, priority: 8 },
  { name: "policy:tool_risk", layer: GateLayer.Policy, description: "Blocks Risk 4-5 tools requiring per-invocation confirmation", canBlock: true, priority: 9 },

  // ── Policy layer — pre-round filters (pass-through, not block) ──
  { name: "policy:context_budget", layer: GateLayer.Policy, description: "Warns/blocks when context exceeds threshold", canBlock: true, priority: 1 },
  { name: "policy:tool_disclosure", layer: GateLayer.Policy, description: "Narrows tool set by context keywords (never blocks)", canBlock: false, priority: 2 },
  { name: "policy:readonly_plan", layer: GateLayer.Policy, description: "Filters to readonly tools when planning or intent demands", canBlock: false, priority: 3 },
  { name: "policy:context_readiness_filter", layer: GateLayer.Policy, description: "Filters to readonly tools when context readiness is blocked", canBlock: false, priority: 4 },
  { name: "policy:ripple_tool_filter", layer: GateLayer.Policy, description: "Filters to readonly tools when ripple blocks writes", canBlock: false, priority: 5 },

  // ── Semantic layer — completion ──
  { name: "semantic:ripple_exit", layer: GateLayer.Semantic, description: "Blocks completion when ripple obligations are pending", canBlock: true, priority: 10 },
  { name: "semantic:planning", layer: GateLayer.Semantic, description: "Evaluates plan quality; yields plan_ready or forces revision", canBlock: true, priority: 20 },
  { name: "semantic:task_tracker", layer: GateLayer.Semantic, description: "Blocks completion when task tracker items remain incomplete", canBlock: true, priority: 30 },
  { name: "semantic:quality", layer: GateLayer.Semantic, description: "Blocks completion on low confidence or contract violations", canBlock: true, priority: 40 },
  { name: "semantic:external_completion", layer: GateLayer.Semantic, description: "Cross-checks final text against task requirements", canBlock: true, priority: 50 },
  { name: "semantic:flash_judge", layer: GateLayer.Semantic, description: "Independent model verification of completion claims", canBlock: true, priority: 60 },
  { name: "semantic:evidence", layer: GateLayer.Semantic, description: "Blocks done when required evidence is missing (canClaimDone)", canBlock: true, priority: 70 },
  { name: "semantic:truthfulness", layer: GateLayer.Semantic, description: "Cross-checks final text claims against EvidenceLedger", canBlock: true, priority: 80 },
  { name: "semantic:master_plan", layer: GateLayer.Semantic, description: "MasterPlan node transition tracking", canBlock: false, priority: 90 },
]

/** Look up a manifest entry by name. */
export function findGateInManifest(name: string): GateManifestEntry | undefined {
  return GATE_MANIFEST.find(e => e.name === name)
}

/** List all gates in a given layer. */
export function gatesInLayer(layer: GateLayer): GateManifestEntry[] {
  return GATE_MANIFEST.filter(e => e.layer === layer)
}

/** Get the blocking gates in a layer (filters excluded). */
export function blockingGatesInLayer(layer: GateLayer): GateManifestEntry[] {
  return GATE_MANIFEST.filter(e => e.layer === layer && e.canBlock)
}
