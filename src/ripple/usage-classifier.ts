/**
 * UsageImpact Classifier — Layer 3 of Ripple Engine 2.0.
 *
 * Classifies every caller by HOW it uses a changed symbol, not just
 * THAT it references it. Each combination of ApiChangeKind + UsageKind
 * maps to a specific requiredAction the agent must take.
 *
 * Example: async_boundary_changed + call_expr → "add await to this call"
 *          signature_changed + call_expr → "update arguments to match new signature"
 *          export_removed + type_ref → "migrate type reference to replacement"
 */

import type { ApiChange, ApiChangeKind } from "./api-diff"
import type { RippleCaller } from "./types"

// ── UsageKind ──────────────────────────────────────────────────────

/** 14 usage patterns of how a caller references a symbol. */
export type UsageKind =
  | "call_expr"         // foo(args)
  | "method_call"       // obj.foo(args)
  | "new_instance"      // new Foo(args)
  | "type_ref"          // : Foo, as Foo, <Foo>
  | "extends_clause"    // extends Foo
  | "implements_clause" // implements Foo
  | "generic_arg"       // Array<Foo>, Promise<Foo>
  | "typeof_query"      // typeof foo
  | "destructure"       // { foo } = x, const { foo }
  | "jsx_element"       // <Foo ...>
  | "jsx_attr"          // attr={foo}
  | "re_export"         // export { foo }, export * from
  | "spread_expr"       // ...foo
  | "plain_ref"         // bare identifier (catch-all)

// ── UsageImpact ────────────────────────────────────────────────────

export interface UsageImpact {
  caller: RippleCaller
  usage: UsageKind
  /** What the agent must do at this call site given the change kind. */
  requiredAction: string
  /** Heuristic confidence 0-1. Based on regex pattern match quality. */
  confidence: number
}

// ── Classifier ─────────────────────────────────────────────────────

/**
 * Classify one caller by its source text.
 *
 * Detection order matters — earlier patterns are more specific.
 * The plain_ref catch-all fires only when nothing else matches.
 *
 * Note: this classifies usage pattern purely from source text. The
 * ApiChange context is applied later by `resolveAction` in classifyCallers.
 */
export function classifyOneCaller(
  caller: RippleCaller,
  symbol: string,
): UsageImpact {
  const text = caller.text
  const escaped = escapeRegex(symbol)

  // Confidence: 1.0 when the symbol appears directly in the text,
  // lower when the match is fuzzy (may be from import line).
  const symbolInText = new RegExp(`\\b${escaped}\\b`).test(text)
  const baseConfidence = symbolInText ? 1.0 : 0.6

  // Detection order matters — more specific patterns must fire before
  // broader ones that would also match the same text.

  // ── 1. extends clause (very specific) ──
  if (new RegExp(`extends\\s+${escaped}\\b`).test(text)) {
    return { caller, usage: "extends_clause", confidence: 0.95, requiredAction: "" }
  }

  // ── 2. implements clause (very specific) ──
  if (new RegExp(`implements\\s+.*\\b${escaped}\\b`).test(text)) {
    return { caller, usage: "implements_clause", confidence: 0.95, requiredAction: "" }
  }

  // ── 3. typeof query (very specific) ──
  if (new RegExp(`typeof\\s+${escaped}\\b`).test(text)) {
    return { caller, usage: "typeof_query", confidence: 0.95, requiredAction: "" }
  }

  // ── 4. re-export (very specific — check before destructure) ──
  if (new RegExp(`export\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}`).test(text) ||
      new RegExp(`export\\s+\\*\\s+from`).test(text)) {
    return { caller, usage: "re_export", confidence: 0.9, requiredAction: "" }
  }

  // ── 5. new expression: new Foo(...) ──
  if (new RegExp(`new\\s+${escaped}\\s*[\\(<{]`).test(text)) {
    return { caller, usage: "new_instance", confidence: 0.95, requiredAction: "" }
  }

  // ── 6. Generic argument: Array<Sym>, Map<K,Sym>, Promise<Sym> ──
  //     Check BEFORE jsx_element — <Sym> inside angle brackets is a
  //     type parameter, not a JSX element.
  if (new RegExp(`<\\s*${escaped}\\s*[>,]`).test(text) ||
      new RegExp(`,\\s*${escaped}\\s*>`).test(text)) {
    return { caller, usage: "generic_arg", confidence: 0.7, requiredAction: "" }
  }

  // ── 7. JSX element: <Symbol ...> or <Symbol /> ──
  //     Only when Symbol follows < and NOT preceded by a letter (excludes
  //     Array<Symbol> — that's a generic arg, caught above).
  if (new RegExp(`(?:^|\\s|\\(|\\{|return\\s+)<${escaped}[\\s/>]`).test(text)) {
    return { caller, usage: "jsx_element", confidence: 0.95, requiredAction: "" }
  }

  // ── 8. Spread: ...symbol (check before jsx_attr — { ...sym } is not JSX) ──
  if (new RegExp(`\\.\\.\\.\\s*${escaped}\\b`).test(text)) {
    return { caller, usage: "spread_expr", confidence: 0.95, requiredAction: "" }
  }

  // ── 9. Destructure: { symbol } =, const { symbol, ... } ──
  //     Check BEFORE jsx_attr since both match { ... } patterns.
  //     Exclude: attr={symbol} (JSX) — has = immediately before {
  if (new RegExp(`\\{\\s*${escaped}\\s*[,\\}]`).test(text)) {
    if (!/^import\s/.test(text.trimStart())) {
      const braceIdx = text.search(new RegExp(`\\{\\s*${escaped}\\s*[,\\}]`))
      // If = immediately precedes {, it's JSX attr (attr={sym}), not destructure
      // braceIdx === 0 is fine (start-of-line destructure)
      if (braceIdx === 0 || (braceIdx > 0 && text[braceIdx - 1] !== "=")) {
        return { caller, usage: "destructure", confidence: 0.8, requiredAction: "" }
      }
    }
  }

  // ── 10. JSX attribute: attr={symbol} (must contain < to be JSX context) ──
  //      Only after destructure and spread are ruled out.
  if (text.includes("<") &&
      new RegExp(`\\{[^}]*\\b${escaped}\\b[^}]*\\}`).test(text) && /[=<]/.test(text)) {
    return { caller, usage: "jsx_attr", confidence: 0.85, requiredAction: "" }
  }

  // ── 11. Method call: obj.symbol(...) (before direct call) ──
  if (new RegExp(`\\.${escaped}\\s*\\(`).test(text)) {
    return { caller, usage: "method_call", confidence: 0.95, requiredAction: "" }
  }

  // ── 12. Direct call: symbol(...) ──
  if (new RegExp(`\\b${escaped}\\s*\\(`).test(text)) {
    return { caller, usage: "call_expr", confidence: 0.95, requiredAction: "" }
  }

  // ── 13. Type reference: : Symbol, as Symbol, Symbol[] ──
  if (new RegExp(`:\\s*.*\\b${escaped}\\b`).test(text) ||
      new RegExp(`\\bas\\s+${escaped}\\b`).test(text) ||
      new RegExp(`\\b${escaped}\\[\\]`).test(text)) {
    return { caller, usage: "type_ref", confidence: 0.85, requiredAction: "" }
  }

  // ── 14. Plain reference (catch-all) ──
  return { caller, usage: "plain_ref", confidence: baseConfidence, requiredAction: "" }
}

/**
 * Classify all callers against the relevant ApiChanges.
 *
 * Each caller's usage is classified first, then the requiredAction
 * is resolved by combining UsageKind + ApiChangeKind.
 */
export function classifyCallers(
  callers: RippleCaller[],
  apiChanges: ApiChange[],
): UsageImpact[] {
  // Build lookup: symbol → ApiChange[] (one symbol can have multiple changes)
  const changeBySymbol = new Map<string, ApiChange[]>()
  for (const c of apiChanges) {
    const name = c.symbol.split(".")[0] ?? c.symbol
    const existing = changeBySymbol.get(name)
    if (existing) { existing.push(c) }
    else { changeBySymbol.set(name, [c]) }
  }

  return callers.map(caller => {
    const changes = changeBySymbol.get(caller.symbol) ?? []
    const impact = classifyOneCaller(caller, caller.symbol)
    impact.requiredAction = resolveAction(impact.usage, changes)

    return impact
  })
}

// ── Action resolution ──────────────────────────────────────────────

/**
 * Resolve the required action for a usage + change combination.
 *
 * Priority order for multi-change symbols:
 *   1. async_boundary_changed + call_expr → await is urgent
 *   2. export_removed → migration is critical
 *   3. signature_changed → argument update
 *   4. return_type_changed → handle new type
 *   5. interface_field_removed → remove field access
 *   6. kind_changed → verify consumers
 *   7. export_added, interface_field_added → informational
 */
function resolveAction(usage: UsageKind, changes: ApiChange[]): string {
  const kinds = new Set(changes.map(c => c.kind))

  // ── async_boundary_changed ──
  if (kinds.has("async_boundary_changed")) {
    switch (usage) {
      case "call_expr": return "add await to this call"
      case "method_call": return "add await to this method call"
      case "new_instance": return "verify constructor remains sync after async change"
      case "jsx_element": return "verify component handles async props"
      case "plain_ref": return "check if this reference needs await"
      default: return "handle async boundary change"
    }
  }

  // ── export_removed ──
  if (kinds.has("export_removed")) {
    switch (usage) {
      case "call_expr": return "migrate call to replacement or remove"
      case "type_ref": return "migrate type reference to replacement"
      case "extends_clause": return "update extends to replacement class"
      case "implements_clause": return "update implements to replacement interface"
      case "re_export": return "update or remove re-export"
      case "destructure": return "remove destructured symbol"
      default: return "remove or migrate reference to removed symbol"
    }
  }

  // ── signature_changed ──
  if (kinds.has("signature_changed")) {
    switch (usage) {
      case "call_expr": return "update arguments to match new signature"
      case "method_call": return "update method arguments"
      case "new_instance": return "update constructor arguments"
      case "generic_arg": return "check generic constraints match new signature"
      default: return "verify usage matches new signature"
    }
  }

  // ── return_type_changed ──
  if (kinds.has("return_type_changed")) {
    switch (usage) {
      case "call_expr": return "update code to handle new return type"
      case "type_ref": return "update type annotation for new return type"
      case "destructure": return "verify destructured fields still exist"
      default: return "handle new return type"
    }
  }

  // ── interface_field_removed ──
  if (kinds.has("interface_field_removed")) {
    switch (usage) {
      case "destructure": return "remove destructured field"
      case "call_expr": return "verify field access handles removal"
      case "spread_expr": return "omit removed field from spread"
      default: return "remove reference to deleted field"
    }
  }

  // ── kind_changed ──
  if (kinds.has("kind_changed")) {
    switch (usage) {
      case "call_expr": return "verify call works with new declaration kind"
      case "type_ref": return "update type usage for new declaration kind"
      case "new_instance": return "verify construction after kind change"
      default: return "verify usage with new declaration kind"
    }
  }

  // ── export_added / interface_field_added (informational) ──
  if (kinds.has("export_added") || kinds.has("interface_field_added")) {
    return "no action required (new API)"
  }

  return "verify this reference is compatible with the change"
}

// ── Utility ────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Generate a concise summary of usage impacts for model context.
 * Groups by usage kind + action for readability.
 */
export function formatUsageSummary(impacts: UsageImpact[]): string {
  if (impacts.length === 0) return ""

  const byAction = new Map<string, UsageImpact[]>()
  for (const imp of impacts) {
    const key = imp.requiredAction
    const existing = byAction.get(key)
    if (existing) { existing.push(imp) }
    else { byAction.set(key, [imp]) }
  }

  const lines: string[] = []
  for (const [action, group] of byAction) {
    const files = [...new Set(group.map(i => `${i.caller.file}:${i.caller.line}`))]
    const examples = files.slice(0, 3).join(", ")
    const more = files.length > 3 ? ` (+${files.length - 3} more)` : ""
    lines.push(`  ${action}: ${examples}${more}`)
  }

  return lines.join("\n")
}

/**
 * Group impacts by severity of action required.
 * "urgent" = async/removal changes, "actionable" = signature/type changes,
 * "info" = informational only.
 */
export function urgencyLevel(impacts: UsageImpact[]): "urgent" | "actionable" | "info" {
  if (impacts.length === 0) return "info"

  const actions = [...new Set(impacts.map(i => i.requiredAction))]
  const urgentPatterns = [/await/, /remove/, /migrate/]
  const infoPatterns = [/no action required/]

  // Filter out purely informational actions
  const nonInfoActions = actions.filter(a => infoPatterns.every(p => !p.test(a)))
  if (nonInfoActions.length === 0) return "info"

  // Urgent if ANY action requires await/remove/migrate
  if (nonInfoActions.some(a => urgentPatterns.some(p => p.test(a)))) return "urgent"

  return "actionable"
}
