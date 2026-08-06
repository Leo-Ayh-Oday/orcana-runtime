/** Plan-layer context providers (H10, plan §16.4).
 *
 *  plan-state wraps buildPlanStateContext (the loop's Layer-2 message that
 *  survives epoch rollover); research passes the prepared research evidence
 *  content through byte-for-byte.
 *
 *  RC-18 annotations: both carry K7 authority and a K54 freshness contract
 *  (plan → version = round, research → generation = epoch index).
 */

import type { ContextContribution, ContextProvider, ContextRequest } from "../../contracts/context"
import { buildPlanStateContext } from "../../../agent/context-epoch"

export const PLAN_STATE_PROVIDER: ContextProvider = {
  id: "plan-state",
  layer: "plan",
  priority: 10,
  cacheable: true,
  async provide(request: ContextRequest) {
    const content = buildPlanStateContext(request.planState)
    return {
      providerId: "plan-state",
      layer: "plan",
      priority: 10,
      content,
      estimatedTokens: Math.ceil(content.length / 3),
      sourceRefs: [],
      required: true,
      // K7: harness-built plan state (system context that survives epoch
      // rollover) — system authority.
      authority: "system",
      // K54: plan-family content versioned by round.
      freshnessContract: { kind: "plan", version: request.planState.round },
    }
  },
}

export const RESEARCH_PROVIDER: ContextProvider = {
  id: "research",
  layer: "plan",
  priority: 20,
  cacheable: false,
  async provide(request: ContextRequest) {
    const content = request.researchContextContent ?? ""
    return {
      providerId: "research",
      layer: "plan",
      priority: 20,
      content,
      estimatedTokens: Math.ceil(content.length / 3),
      sourceRefs: [],
      required: false,
      // K7: research evidence is tool-gathered facts — tool authority.
      authority: "tool",
      // K54: evidence-family content versioned by epoch generation (research
      // context is regenerated per run/epoch; no generation counter exists).
      // H12: epochState optional — node-mode requests have no epoch.
      freshnessContract: { kind: "evidence", generation: request.epochState?.currentEpochIndex ?? 0 },
    }
  },
}
