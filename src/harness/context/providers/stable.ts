/** Stable-layer context providers (H10, plan §16.4).
 *
 *  Byte-frozen contract with the loop's stable prefix (round.ts :157-172):
 *  on round 0 each part contributes its content and the group assembler
 *  builds `## Stable Prefix Context\n[CACHE_ANCHOR:v3]`; from round 1 the
 *  frozen prefix is authoritative and only stable-memory carries it through
 *  byte-for-byte (plan §23 cache stability — never rebuilt).
 */

import type { ContextContribution, ContextProvider, ContextRequest } from "../../contracts/context"

function part(providerId: string, content: string, cacheKey?: string): ContextContribution {
  return {
    providerId,
    layer: "stable",
    priority: 0,
    content,
    estimatedTokens: Math.ceil(content.length / 3),
    sourceRefs: [],
    cacheKey,
    required: false,
    group: "stable-prefix",
  }
}

export const LANG_INSTRUCTION_PROVIDER: ContextProvider = {
  id: "lang-instruction",
  layer: "stable",
  priority: 0,
  cacheable: true,
  async provide(request: ContextRequest) {
    return {
      providerId: "lang-instruction",
      layer: "stable",
      priority: 0,
      content: request.langInstruction,
      estimatedTokens: Math.ceil(request.langInstruction.length / 3),
      sourceRefs: [],
      cacheKey: "lang-instruction:v1",
      required: false,
    }
  },
}

export const STABLE_MEMORY_PROVIDER: ContextProvider = {
  id: "stable-memory",
  layer: "stable",
  priority: 10,
  cacheable: true,
  async provide(request: ContextRequest) {
    // Rounds ≥ 1: the frozen prefix is the authoritative source — pass it
    // through byte-for-byte; the other stable parts return empty.
    if (request.frozenStablePrefixContent !== null) {
      return part("stable-memory", request.frozenStablePrefixContent, "stable-prefix:v3")
    }
    const parts: string[] = []
    if (request.stableMemoryContext?.trim()) parts.push(`## Stable Cold Memory\n${request.stableMemoryContext.trim()}`)
    if (request.experienceContext) parts.push(request.experienceContext)
    return part("stable-memory", parts.join("\n\n"), "stable-prefix:v3")
  },
}

export const PROJECT_KERNEL_PROVIDER: ContextProvider = {
  id: "project-kernel",
  layer: "stable",
  priority: 20,
  cacheable: true,
  async provide(request: ContextRequest) {
    if (request.frozenStablePrefixContent !== null) return part("project-kernel", "")
    const text = request.contextKernel.text
    return part("project-kernel", text ? `## Project Context Kernel\n${text}` : "", `kernel:${request.contextKernel.hash}`)
  },
}

export const CONTEXT_MAP_PROVIDER: ContextProvider = {
  id: "context-map",
  layer: "stable",
  priority: 30,
  cacheable: true,
  async provide(request: ContextRequest) {
    if (request.frozenStablePrefixContent !== null) return part("context-map", "")
    return part("context-map", request.contextMapContext)
  },
}

export const SKILLS_PROVIDER: ContextProvider = {
  id: "skills",
  layer: "stable",
  priority: 40,
  cacheable: true,
  async provide(request: ContextRequest) {
    if (request.frozenStablePrefixContent !== null) return part("skills", "")
    return part("skills", request.triageSkillPrompts.join("\n\n"))
  },
}
