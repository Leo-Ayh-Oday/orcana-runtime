/** Pre-round gates: composed via GateChain.pipe() before each provider call.
 *
 *  Chain order:
 *    1. ContextBudgetGate — block if context over threshold
 *    2. ToolDisclosureGate — narrow tool set by context keywords
 *    3. ReadonlyPlanGate — filter to readonly when intent/planning demands it
 *    4. RippleToolFilterGate — filter by ripple decisions
 *
 *  Each gate reads ctx.tools (narrowed by previous gate) and writes back
 *  the filtered result. ctx.fullTools is preserved for cache-stable bypass.
 *  First block stops the chain.
 */

import type { Gate, GateResult } from "./types"
import type { PreRoundContext } from "./contexts"
import { selectTools } from "../tool-disclosure"
import type { RippleReport } from "../../ripple/types"
import { getBlockingObligations, type RippleObligation } from "../../ripple/obligations"

// ── Gate: Tool Disclosure ──

export class ToolDisclosureGate implements Gate<PreRoundContext> {
  readonly name = "policy:tool_disclosure"

  evaluate(ctx: PreRoundContext): GateResult {
    if (ctx.cacheStableTools) return { pass: true }

    const result = selectTools(ctx.fullTools, ctx.disclosureContextText, ctx.round)
    ctx.tools = result.selected
    ctx.activeTools = result.selected
    ctx.tokensSaved = result.tokensSaved
    return { pass: true }
  }
}

// ── Gate: Readonly / Plan-Only ──

export class ReadonlyPlanGate implements Gate<PreRoundContext> {
  readonly name = "policy:readonly_plan"

  evaluate(ctx: PreRoundContext): GateResult {
    if (ctx.cacheStableTools) return { pass: true }

    if (ctx.intentReadonly || ctx.taskPlanning) {
      ctx.tools = ctx.tools.filter(t => t.defn.isReadonly)
    }
    // Plan-only round: no tools at all
    if (ctx.taskPlanning && ctx.round > 0) {
      ctx.activeTools = []
    } else {
      ctx.activeTools = ctx.tools
    }
    return { pass: true }
  }
}

// ── Gate: Context readiness ──

export class ContextReadinessToolFilterGate implements Gate<PreRoundContext> {
  readonly name = "policy:context_readiness_filter"

  evaluate(ctx: PreRoundContext): GateResult {
    if (ctx.contextReadinessBlocked) {
      ctx.tools = ctx.tools.filter(t => t.defn.isReadonly)
      ctx.activeTools = ctx.tools
      ctx.contextReadinessBlockActive = true
    } else {
      ctx.contextReadinessBlockActive = false
    }
    return { pass: true }
  }
}

// ── Gate: Ripple Tool Filter ──

export class RippleToolFilterGate implements Gate<PreRoundContext> {
  readonly name = "policy:ripple_tool_filter"

  evaluate(ctx: PreRoundContext): GateResult {
    if (ctx.cacheStableTools) {
      ctx.rippleBlockActive = false
      return { pass: true }
    }

    const decision = strongestRippleDecision(ctx.rippleReports, ctx.pendingRippleObligations)
    if (decision === "block") {
      ctx.tools = ctx.tools.filter(t => t.defn.isReadonly)
      ctx.activeTools = ctx.tools
      ctx.rippleBlockActive = true
    } else {
      ctx.rippleBlockActive = false
    }
    return { pass: true }
  }
}

function strongestRippleDecision(reports: RippleReport[], pending: RippleObligation[]): "allow" | "warn" | "block" | undefined {
  if (getBlockingObligations(pending).length > 0) return "warn"
  if (reports.some(report => report.decision === "block")) return "block"
  if (reports.some(report => report.decision === "warn")) return "warn"
  if (reports.length > 0) return "allow"
  return undefined
}

// ── Convenience: build the default pre-round chain ──

import { ContextBudgetGate } from "./context-budget"
import { GateChain } from "./chain"

export function createPreRoundChain(): GateChain<PreRoundContext> {
  return GateChain.pipe([
    new ContextBudgetGate(),
    new ToolDisclosureGate(),
    new ReadonlyPlanGate(),
    new ContextReadinessToolFilterGate(),
    new RippleToolFilterGate(),
  ])
}
