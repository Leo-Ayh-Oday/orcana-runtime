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

// ── Gate: Context readiness（IC05 P2: advisory —— 不再 filter write tools）──

export class ContextReadinessToolFilterGate implements Gate<PreRoundContext> {
  readonly name = "policy:context_readiness_filter"

  evaluate(ctx: PreRoundContext): GateResult {
    // IC05: ContextReadiness 是 advisory gate。write tools 保持暴露，
    // readiness blockers 以 ContextDebt（obligation）形式在 DONE 前偿还。
    ctx.contextReadinessBlockActive = false
    return { pass: true }
  }
}

// ── Gate: Ripple Tool Filter ──

export class RippleToolFilterGate implements Gate<PreRoundContext> {
  readonly name = "policy:ripple_tool_filter"

  evaluate(ctx: PreRoundContext): GateResult {
    // RC-05 B4: ripple 阻断是正确性 Gate，与 cacheStableTools（性能选项）完全独立。
    // cache 开启时 ripple block 会让工具集变化（cache miss）——正确性优先，接受该代价。
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

/** IC05 P5: deterministic contract-violation kinds（真实 API surface diff）。 */
export const DETERMINISTIC_RIPPLE_KINDS = new Set<string>([
  "exported-symbol-removal",
  "deprecated-replacement",
  "async-return-change",
  "exported-type-change",
  "signature-change",
])

/** IC05 P5: heuristic kinds —— 永远不单独获得 write hard-block 权。 */
export const HEURISTIC_RIPPLE_KINDS = new Set<string>([
  "caller-overflow",
  "depth-warning",
  "memory-contract",
])

/** 报告是否存在 deterministic contract violation（→ hard block）。 */
export function hasDeterministicBlockingRipple(report: RippleReport): boolean {
  return report.findings.some(
    f => DETERMINISTIC_RIPPLE_KINDS.has(f.kind) && (f.severity === "block" || f.severity === "warn"),
  )
}

function strongestRippleDecision(reports: RippleReport[], pending: RippleObligation[]): "allow" | "warn" | "block" | undefined {
  if (getBlockingObligations(pending).length > 0) return "warn"
  // IC05: 只有 deterministic contract violation 能 hard-block write；
  // heuristic（caller-overflow / depth-warning / memory-contract）最多
  // warn（→ obligation），HEURISTIC_RIPPLE_WRITE_BLOCK=0。
  if (reports.some(report => hasDeterministicBlockingRipple(report))) return "block"
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
