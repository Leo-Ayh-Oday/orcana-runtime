/** MasterPlan controller (ALK PR-L7).
 *
 *  The three closures that previously lived in loop.ts (syncModeWithMasterPlan,
 *  activateMasterPlan, tryNodeTransition) become ctx-taking functions. They own
 *  the master-plan activation and node-transition behavior: they commit
 *  planning.taskTracker swaps and plan-store updates directly (documented
 *  controller mutations — object identity must be preserved), while the
 *  round/prepare bodies route their own field commits through RunEffect.
 */

import { setCurrentPlan } from "../run/plan-store"
import { setActivePatchContext } from "../patch-transaction"
import { getActiveMode, setActiveMode, shouldTransitionMode } from "../mode-contract"
import type { ModeTransitionContext } from "../mode-contract"
import {
  buildNodeReviewGate,
  createMasterPlan,
  createMasterPlanFromPacket,
  currentNode,
  markNodeDone,
  nodesFromPlanText,
  planComplete,
  planProgress,
} from "../master-plan"
import { formatValidationReport, validatePlan } from "../plan-validator"
import type { TaskPacket } from "../task-packet"
import type { RunPhaseContext } from "./types"

/** PR 8: keep the active mode contract in sync with master-plan progress. */
export function syncModeWithMasterPlan(ctx: RunPhaseContext): void {
  if (!ctx.planStore.current) return
  const activeNode = currentNode(ctx.planStore.current)
  const transitionCtx: ModeTransitionContext = {
    activeNodeStatus: activeNode?.status,
    hasTrackerSteps: (activeNode?.tracker?.steps?.length ?? 0) > 0,
    rippleObligationCount: ctx.verificationState.rippleObligations.length,
    hasEvidence: ctx.evidenceLedger.entries.length > 0,
    toolErrors: ctx.errorTracker.errorCount,
    planComplete: planComplete(ctx.planStore.current),
  }
  const newMode = shouldTransitionMode(getActiveMode().mode, transitionCtx)
  if (newMode) {
    setActiveMode(newMode)
  }
}

/** Activate a MasterPlan from a planning artifact (or a force-passed packet). */
export function activateMasterPlan(
  ctx: RunPhaseContext,
  planText: string,
  goal: string,
  forcePassPacket?: TaskPacket,
): boolean {
  const { planning, planStore } = ctx
  // PR 3: if force-passed with a minimal viable packet, use it directly
  if (forcePassPacket) {
    const packet = ctx.contextMap.planContextAttachment
      ? {
          ...forcePassPacket,
          contextMapId: forcePassPacket.contextMapId ?? ctx.contextMap.planContextAttachment.contextMapId,
          requiredContextEvidence: forcePassPacket.requiredContextEvidence?.length
            ? forcePassPacket.requiredContextEvidence
            : ctx.contextMap.planContextAttachment.requiredContextEvidence,
        }
      : forcePassPacket
    const plan = createMasterPlanFromPacket(packet, "long_task")
    setCurrentPlan(planStore, plan)
    const cur = currentNode(plan)
    if (!cur) return false
    planning.taskTracker = cur.tracker
    // PR 5: set active patch context from node's TaskPacket
    if (cur._packet) {
      setActivePatchContext({
        scope: cur._packet.scope,
        verification: cur._packet.verification.map(v => v.kind),
        nodeId: cur.id,
      })
    }
    syncModeWithMasterPlan(ctx)
    return true
  }

  const nodes = nodesFromPlanText(planText)
  const titles = nodes.length > 0
    ? nodes.map(n => n.title)
    : [goal.slice(0, 120) || "主要任务"]
  const plan = createMasterPlan(goal, "long_task", titles, ctx.contextMap.planContextAttachment)
  // Transfer parsed dependencies
  for (let i = 0; i < Math.min(nodes.length, plan.nodes.length); i++) {
    for (const depIdx of nodes[i]?.dependsOn ?? []) {
      const dep = plan.nodes[depIdx - 1]
      const cur = plan.nodes[i]
      if (dep && cur && !cur.dependsOn.includes(dep.id)) {
        cur.dependsOn.push(dep.id); dep.blockedBy.push(cur.id)
      }
    }
  }
  setCurrentPlan(planStore, plan)
  // PR 3: re-validate after dependency transfer — mutations may introduce cycles
  plan._lastValidation = validatePlan(plan)
  const cur = currentNode(plan)
  if (!cur) return false
  planning.taskTracker = cur.tracker
  // PR 5: set active patch context from node's TaskPacket
  if (cur._packet) {
    setActivePatchContext({
      scope: cur._packet.scope,
      verification: cur._packet.verification.map(v => v.kind),
      nodeId: cur.id,
    })
  }
  syncModeWithMasterPlan(ctx)
  return true
}

/** MasterPlan node transition — called after current node passes all completion gates. */
export function tryNodeTransition(ctx: RunPhaseContext): boolean {
  const { planning, planStore } = ctx
  if (!planStore.current || !planning.taskTracker) return false
  const cur = currentNode(planStore.current)
  if (cur) markNodeDone(planStore.current, cur.id, "验证通过")
  const review = buildNodeReviewGate(planStore.current, cur?.id ?? "")
  // PR 3: validate plan before injecting review prompt
  planStore.current._lastValidation = validatePlan(planStore.current)
  // Inject as user message — this is an instruction to review the plan, not model output
  const validationText = formatValidationReport(planStore.current._lastValidation)
  const fullPrompt = validationText
    ? `${review.promptText.slice(0, 1600)}\n\n${validationText}`
    : review.promptText.slice(0, 2000)
  ctx.rawMessages.push({ role: "user" as const, content: fullPrompt })
  syncModeWithMasterPlan(ctx)
  if (planComplete(planStore.current)) return false
  // Blocked nodes still need model review — continue even when !review.resume
  if (review.remaining === 0) return false
  // If next node was auto-activated, swap to its tracker
  const next = currentNode(planStore.current)
  if (next && review.resume) {
    planning.taskTracker = next.tracker
    // PR 5: set active patch context from next node's TaskPacket
    if (next._packet) {
      setActivePatchContext({
        scope: next._packet.scope,
        verification: next._packet.verification.map(v => v.kind),
        nodeId: next.id,
      })
    }
  }
  syncModeWithMasterPlan(ctx)
  return true
}
