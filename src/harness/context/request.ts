/** Kernel → harness context request bridge (H10).
 *
 *  The single file that imports kernel internals (RunPhaseContext) — the
 *  same precedent as legacy-loop-adapter importing loop types. The old
 *  in-round planStateInput construction moves here so providers read one
 *  consistent request shape.
 */

import type { ContextRequest } from "../contracts/context"
import type { RunPhaseContext } from "../../agent/kernel/types"
import type { PlanStateInput } from "../../agent/context-epoch"
import { currentNode } from "../../agent/master-plan"
import { getActiveMode } from "../../agent/mode-contract"

/** Build the context request for one round from the kernel run context. */
export function createContextRequest(ctx: RunPhaseContext, round: number): ContextRequest {
  const planStateInput: PlanStateInput = {
    masterPlan: ctx.planStore.current,
    taskTracker: ctx.planning.taskTracker,
    taskPacket: ctx.planStore.current
      ? (currentNode(ctx.planStore.current)?._packet ?? null)
      : null,
    rippleObligations: ctx.verificationState.rippleObligations,
    userGoal: ctx.planStore.current?.goal ?? ctx.planning.taskTracker?.goal ?? ctx.effectivePrompt.slice(0, 200),
    decisions: [], // TODO PR 6/7: wire Evidence/Ripple decisions into plan state
    round,
  }

  const frozen = ctx.runState.conversation.frozenStablePrefix
  const researchMessage = ctx.runState.research.context
  return {
    round,
    effectivePrompt: ctx.effectivePrompt,
    contextMax: ctx.CONTEXT_MAX,
    langInstruction: ctx.langInstruction,
    frozenStablePrefixContent: frozen && typeof frozen.content === "string" ? frozen.content : null,
    stableMemoryContext: ctx.options.stableMemoryContext,
    experienceContext: ctx.experienceContext,
    contextKernel: ctx.contextKernel,
    contextMapContext: ctx.contextMap.contextMapContext,
    triageSkillPrompts: ctx.triageSkillPrompts,
    planState: planStateInput,
    // Research evidence is always built with string content; the non-string
    // branch is defensive only and never reached on the frozen path.
    researchContextContent: researchMessage
      ? typeof researchMessage.content === "string"
        ? researchMessage.content
        : JSON.stringify(researchMessage.content)
      : null,
    stagedContext: ctx.stagedContext,
    thinkingStore: ctx.thinkingStore,
    knowledgeBase: ctx.knowledgeBase,
    taskTracker: ctx.planning.taskTracker,
    mode: getActiveMode(),
    rawMessages: ctx.rawMessages,
    epochState: ctx.epochState,
  }
}
