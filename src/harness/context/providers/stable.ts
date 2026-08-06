/** Stable-layer context providers (H10, plan §16.4).
 *
 *  Byte-frozen contract with the loop's stable prefix (round.ts :157-172):
 *  on round 0 each part contributes its content and the group assembler
 *  builds `## Stable Prefix Context\n[CACHE_ANCHOR:v3]`; from round 1 the
 *  frozen prefix is authoritative and only stable-memory carries it through
 *  byte-for-byte (plan §23 cache stability — never rebuilt).
 *
 *  RC-18 annotations: every part carries a K7 authority level and, for
 *  file-sourced parts, a K54 freshness contract ({kind:"file", digest}) so a
 *  fork/cache of the stable prefix can detect content drift (K40 linkage).
 */

import type { ContextContribution, ContextProvider, ContextRequest } from "../../contracts/context"
import { contentDigest, type ContextAuthority, type FreshnessContract } from "../request"

function part(
  providerId: string,
  priority: number,
  content: string,
  opts: { cacheKey?: string; authority?: ContextAuthority; freshnessContract?: FreshnessContract } = {},
): ContextContribution {
  return {
    providerId,
    layer: "stable",
    priority,
    content,
    estimatedTokens: Math.ceil(content.length / 3),
    sourceRefs: [],
    cacheKey: opts.cacheKey,
    required: false,
    group: "stable-prefix",
    authority: opts.authority,
    freshnessContract: opts.freshnessContract,
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
      // K7: harness-injected language rules — system authority. Immutable
      // per run, so no freshness contract (nothing can drift).
      authority: "system",
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
      return part("stable-memory", 10, request.frozenStablePrefixContent, { cacheKey: "stable-prefix:v3", authority: "memory" })
    }
    const parts: string[] = []
    if (request.stableMemoryContext?.trim()) parts.push(`## Stable Cold Memory\n${request.stableMemoryContext.trim()}`)
    if (request.experienceContext) parts.push(request.experienceContext)
    // K7: cold memory — "memory" authority. Byte-frozen once built (cache
    // key stable-prefix:v3), so no freshness contract.
    return part("stable-memory", 10, parts.join("\n\n"), { cacheKey: "stable-prefix:v3", authority: "memory" })
  },
}

export const PROJECT_KERNEL_PROVIDER: ContextProvider = {
  id: "project-kernel",
  layer: "stable",
  priority: 20,
  cacheable: true,
  async provide(request: ContextRequest) {
    if (request.frozenStablePrefixContent !== null) return part("project-kernel", 20, "", { authority: "system" })
    // H12: contextKernel is optional — node-mode requests (no kernel round
    // state) omit it and contribute nothing here.
    const text = request.contextKernel?.text ?? ""
    return part("project-kernel", 20, text ? `## Project Context Kernel\n${text}` : "", {
      cacheKey: `kernel:${request.contextKernel?.hash ?? "none"}`,
      // K7: project rules / kernel — system authority.
      authority: "system",
      // K54/K40: file-sourced (drift-prone) — digest from the kernel's own
      // content hash; a fork can re-derive it and detect drift.
      ...(request.contextKernel
        ? { freshnessContract: { kind: "file" as const, digest: request.contextKernel.hash } }
        : {}),
    })
  },
}

export const CONTEXT_MAP_PROVIDER: ContextProvider = {
  id: "context-map",
  layer: "stable",
  priority: 30,
  cacheable: true,
  async provide(request: ContextRequest) {
    if (request.frozenStablePrefixContent !== null) return part("context-map", 30, "", { authority: "tool" })
    // H12: contextMapContext is optional — node-mode requests omit it.
    const contextMap = request.contextMapContext ?? ""
    return part("context-map", 30, contextMap, {
      // K7: repo facts gathered by tooling — tool authority.
      authority: "tool",
      // K54/K40: fingerprint the content string so fork/cache drift is
      // detectable without re-reading files.
      freshnessContract: { kind: "file", digest: contentDigest(contextMap) },
    })
  },
}

export const SKILLS_PROVIDER: ContextProvider = {
  id: "skills",
  layer: "stable",
  priority: 40,
  cacheable: true,
  async provide(request: ContextRequest) {
    if (request.frozenStablePrefixContent !== null) return part("skills", 40, "", { authority: "system" })
    // K7: skill prompts are system-loaded material — system authority.
    // Static per run, so no freshness contract.
    return part("skills", 40, request.triageSkillPrompts.join("\n\n"), { authority: "system" })
  },
}
