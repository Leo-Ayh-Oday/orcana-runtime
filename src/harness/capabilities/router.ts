/** Capability Router (RT-12): layered dynamic tool disclosure.
 *
 *  Why: static disclosure hands the model the full tool schema every round.
 *  The router splits tools into a small Stable Core (always present) and
 *  task-selected Specialist groups, so simple tasks never pay the token cost
 *  of web/MCP/LSP/repo-map schemas, and network tools are only revealed when
 *  the task profile actually needs them.
 *
 *  Rules (execution-plan §PR-T12):
 *  - Tool order is stable (core order is fixed; specialist groups are
 *    appended in registration order).
 *  - Stable prefix is byte-stable.
 *  - Simple tasks do not load advanced tools (TL-017).
 *  - Network tools are disclosed on demand (web_research / service_ops).
 *  - MCP tools are never in the static profile — they load lazily per task
 *    (dynamic MCP disclosure lands with the bridge).
 *
 *  Note: the plan's Stable Core names `inspect_file` (not yet created) —
 *  `read_file` with selectors covers that role, so it substitutes here.
 */

import type { ToolDef } from "../../tools/registry"
import type { CapabilityDescriptor, CapabilityRegistry } from "../contracts/capability"

// ── Task profiles ──

export type TaskProfileType =
  | "coding"
  | "code_intelligence"
  | "verification"
  | "git_ops"
  | "web_research"
  | "service_ops"
  | "reasoning"

export interface TaskProfile {
  type: TaskProfileType
  /** Optional language hint (e.g. "typescript") — currently informational. */
  language?: string
  /** Context budget hint in tokens; small budgets keep only the core. */
  contextBudgetTokens?: number
  /** Permission set — "full" unlocks higher-risk specialists. */
  permissions?: string[]
}

export interface RouterDecision {
  /** Disclosed capability ids in stable order (core first, meta last). */
  capabilityIds: string[]
  /** Human-readable reason for the disclosure choice. */
  reason: string
  /** Rough token estimate for the disclosed schemas (bytes/4 heuristic). */
  tokenEstimate: number
  /** Ids deliberately excluded this round — disclose on demand as fallback. */
  fallback: string[]
}

// ── Layers ──

/** Always-on core: read/inspect, parameterized process, patch, git status, claim verification. */
export const STABLE_CORE_TOOL_NAMES: readonly string[] = Object.freeze([
  "read_file",
  "run_process",
  "apply_patch",
  "git_status",
  "verify_claim",
])

/** Interaction-critical meta tools: always present so the CLI session cannot dead-end. */
export const ALWAYS_META_TOOL_NAMES: readonly string[] = Object.freeze([
  "ask_user",
  "todo_write",
  "task",
])

export const SPECIALIST_GROUPS: Readonly<Record<Exclude<TaskProfileType, "coding" | "reasoning">, readonly string[]>> = Object.freeze({
  code_intelligence: Object.freeze([
    "find_symbol",
    "find_references",
    "project_structure",
    "build_repo_map",
    "query_repo_map",
    "build_context_slice",
    "lsp_diagnostics",
    "lsp_hover",
    "lsp_definition",
    "lsp_references",
  ]),
  verification: Object.freeze([
    "discover_verification",
    "run_targeted_verification",
    "classify_command_failure",
  ]),
  git_ops: Object.freeze([
    "git_diff",
    "git_log",
    "git_blame",
    "git_show",
    "git_add",
    "git_commit",
  ]),
  web_research: Object.freeze(["web_search", "web_fetch"]),
  service_ops: Object.freeze(["service_start", "service_status", "service_logs", "service_stop"]),
})

const SPECIALIST_ORDER = Object.keys(SPECIALIST_GROUPS) as Array<keyof typeof SPECIALIST_GROUPS>

/** Groups that are also usable for "coding" tasks (writes/process tools). */
const CODING_EXTRA_GROUPS: ReadonlySet<keyof typeof SPECIALIST_GROUPS> = new Set([
  "code_intelligence",
  "verification",
])

/** Token estimate for one tool schema (chars/4 ≈ tokens). */
export function estimateToolTokens(defn: ToolDef): number {
  const schema = JSON.stringify(defn.inputSchema ?? {})
  return Math.ceil((schema.length + defn.description.length) / 4)
}

// ── Router ──

export interface RouteOptions {
  /** Tool pool to disclose from (definitions for token estimation). */
  tools: ToolDef[]
  /** Registry used to verify the chosen ids exist. */
  registry?: CapabilityRegistry
  /** Small context budgets keep only the stable core (schema economy). */
  minContextBudgetTokens?: number
}

/**
 * Decide which capabilities to disclose for a task profile.
 *
 * Pure function: no state, no side effects — the caller binds it to the run.
 * Specialist groups are appended in a stable order; within a group the pool's
 * registration order is preserved.
 */
export function routeCapabilities(
  profile: TaskProfile,
  options: RouteOptions,
): RouterDecision {
  const available = new Set(options.tools.map(t => t.name))
  const byName = new Map(options.tools.map(t => [t.name, t]))
  const tokenBudget = profile.contextBudgetTokens ?? Number.POSITIVE_INFINITY
  const budgetLimited = Number.isFinite(tokenBudget) && tokenBudget < (options.minContextBudgetTokens ?? 4000)

  const core = STABLE_CORE_TOOL_NAMES.filter(name => available.has(name))
  const meta = ALWAYS_META_TOOL_NAMES.filter(name => available.has(name))

  const picked = new Set<string>(core)
  const fallback: string[] = []
  let reason = `stable core (${core.length})`

  const addGroup = (names: readonly string[], why: string) => {
    const present = names.filter(name => available.has(name))
    if (present.length === 0) return
    reason += ` + ${why} (${present.length})`
    for (const name of present) picked.add(name)
  }

  if (budgetLimited) {
    // Token-starved: only the stable core + meta. Specialist tools are listed
    // as fallback so a later round can disclose them on demand.
    for (const group of SPECIALIST_ORDER) fallback.push(...SPECIALIST_GROUPS[group].filter(name => available.has(name)))
    reason = `context budget ${tokenBudget} tokens — stable core only`
  } else if (profile.type === "reasoning") {
    for (const group of SPECIALIST_ORDER) fallback.push(...SPECIALIST_GROUPS[group].filter(name => available.has(name)))
    reason = `reasoning task — stable core only`
  } else if (profile.type === "coding") {
    for (const group of CODING_EXTRA_GROUPS) addGroup(SPECIALIST_GROUPS[group], group)
    for (const group of SPECIALIST_ORDER) {
      if (!CODING_EXTRA_GROUPS.has(group)) fallback.push(...SPECIALIST_GROUPS[group].filter(name => available.has(name)))
    }
    if (profile.language) reason += ` (language=${profile.language})`
  } else {
    addGroup(SPECIALIST_GROUPS[profile.type], profile.type)
    for (const group of SPECIALIST_ORDER) {
      if (group !== profile.type) fallback.push(...SPECIALIST_GROUPS[group].filter(name => available.has(name)))
    }
  }

  for (const name of meta) picked.add(name)

  // Stable order: core (fixed order) → picked specialists in group order →
  // meta. Group order is fixed; pool order inside a group is stable.
  const order = new Map<string, number>()
  core.forEach((name, index) => order.set(name, index))
  SPECIALIST_ORDER.forEach((group, groupIndex) => {
    SPECIALIST_GROUPS[group].forEach((name, nameIndex) => order.set(name, 1000 + groupIndex * 100 + nameIndex))
  })
  meta.forEach((name, index) => order.set(name, 10_000 + index))

  const capabilityIds = [...picked].sort((a, b) => (order.get(a) ?? 99_999) - (order.get(b) ?? 99_999))
  const tokenEstimate = capabilityIds.reduce((sum, name) => {
    const defn = byName.get(name)
    return sum + (defn ? estimateToolTokens(defn) : 0)
  }, 0)

  if (options.registry) {
    // Never disclose a capability the registry does not know.
    const known = new Set(options.registry.list().map(entry => entry.descriptor.id))
    return {
      capabilityIds: capabilityIds.filter(id => known.has(id)),
      reason,
      tokenEstimate,
      fallback: [...new Set(fallback)],
    }
  }
  return { capabilityIds, reason, tokenEstimate, fallback: [...new Set(fallback)] }
}

/** Convenience: get the disclosed ToolDef subset in stable router order. */
export function selectToolDefs(profile: TaskProfile, allTools: ToolDef[]): { tools: ToolDef[]; decision: RouterDecision } {
  const decision = routeCapabilities(profile, { tools: allTools })
  const byName = new Map(allTools.map(t => [t.name, t]))
  const tools = decision.capabilityIds.map(name => byName.get(name)!).filter(Boolean)
  return { tools, decision }
}
