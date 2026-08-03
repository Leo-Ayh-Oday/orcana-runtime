/** Plan-layer context providers (H10, plan §16.4).
 *
 *  plan-state wraps buildPlanStateContext (the loop's Layer-2 message that
 *  survives epoch rollover); research passes the prepared research evidence
 *  content through byte-for-byte.
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
    }
  },
}
