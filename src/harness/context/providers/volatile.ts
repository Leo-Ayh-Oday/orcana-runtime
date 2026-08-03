/** Volatile-layer context providers (H10, plan §16.4).
 *
 *  Byte-frozen contract with the loop's volatile round message (round.ts
 *  :133-154 + pre-loop buildVolatileContextMessage): staged context →
 *  thinking store → knowledge (the INLINE `## 已学知识` format, NOT
 *  KnowledgeBase.buildContext) merge into the volatile-round group;
 *  planning and mode-contract stay standalone messages in legacy order.
 *  conversation-tail is metadata-only in H10 (real tail arrives in H11).
 */

import type { ContextContribution, ContextProvider, ContextRequest } from "../../contracts/context"
import { formatTaskPlanningPrompt } from "../../../agent/task-tracker"
import { formatModePrompt } from "../../../agent/mode-contract"

function part(providerId: string, priority: number, content: string): ContextContribution {
  return {
    providerId,
    layer: "volatile",
    priority,
    content,
    estimatedTokens: Math.ceil(content.length / 3),
    sourceRefs: [],
    required: false,
    group: "volatile-round",
  }
}

export const STAGED_CONTEXT_PROVIDER: ContextProvider = {
  id: "staged-context",
  layer: "volatile",
  priority: 10,
  cacheable: false,
  async provide(request: ContextRequest) {
    const staged = request.stagedContext
    if (!staged || (request.round === 0 && staged.loadedFiles.size === 0)) return part("staged-context", 10, "")
    return part("staged-context", 10, staged.buildContext().toPromptText())
  },
}

export const THINKING_PROVIDER: ContextProvider = {
  id: "thinking",
  layer: "volatile",
  priority: 20,
  cacheable: false,
  async provide(request: ContextRequest) {
    const store = request.thinkingStore
    if (!store || request.round === 0) return part("thinking", 20, "")
    return part("thinking", 20, store.formatForPrompt(store.findSimilar(request.effectivePrompt)))
  },
}

export const KNOWLEDGE_PROVIDER: ContextProvider = {
  id: "knowledge",
  layer: "volatile",
  priority: 30,
  cacheable: false,
  async provide(request: ContextRequest) {
    const kb = request.knowledgeBase
    if (!kb || request.round <= 1) return part("knowledge", 30, "")
    const hits = kb.findRelevant(request.effectivePrompt)
    if (hits.length === 0) return part("knowledge", 30, "")
    // Byte-frozen: the loop's inline format, not KnowledgeBase.buildContext.
    const content = "\n## 已学知识\n" + hits.map((e) => `问题: ${e.problem}\n方案: ${e.solution}`).join("\n\n") + "\n"
    return part("knowledge", 30, content)
  },
}

export const PLANNING_PROVIDER: ContextProvider = {
  id: "planning",
  layer: "volatile",
  priority: 40,
  cacheable: false,
  async provide(request: ContextRequest) {
    const tracker = request.taskTracker
    const content = tracker?.phase === "planning"
      ? formatTaskPlanningPrompt(tracker, request.round)
      : ""
    return {
      providerId: "planning",
      layer: "volatile",
      priority: 40,
      content,
      estimatedTokens: Math.ceil(content.length / 3),
      sourceRefs: [],
      required: true,
      group: undefined,
    }
  },
}

export const MODE_CONTRACT_PROVIDER: ContextProvider = {
  id: "mode-contract",
  layer: "volatile",
  priority: 90,
  cacheable: true,
  async provide(request: ContextRequest) {
    const content = formatModePrompt(request.mode)
    return {
      providerId: "mode-contract",
      layer: "volatile",
      priority: 90,
      content,
      estimatedTokens: Math.ceil(content.length / 3),
      sourceRefs: [],
      cacheKey: `mode:${request.mode.mode}`,
      required: false,
      group: undefined,
    }
  },
}

export const CONVERSATION_TAIL_PROVIDER: ContextProvider = {
  id: "conversation-tail",
  layer: "volatile",
  priority: 100,
  cacheable: false,
  async provide(request: ContextRequest) {
    // Metadata-only in H10: the real tail budget arrives with H11 node
    // context. The epoch/rawMessages facts are exposed for diagnostics.
    return {
      providerId: "conversation-tail",
      layer: "volatile",
      priority: 100,
      content: "",
      estimatedTokens: 0,
      sourceRefs: [`epoch:${request.epochState.currentEpochIndex}`, `raw:${request.rawMessages.length}`],
      required: false,
      group: undefined,
    }
  },
}
