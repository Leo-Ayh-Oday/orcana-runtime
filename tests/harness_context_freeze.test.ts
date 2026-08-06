import { describe, expect, test } from "bun:test"
import { agentLoop } from "../src/agent/loop"
import { createDefaultContextProviders } from "../src/harness/context/providers"
import { runContextPipeline } from "../src/harness/context/pipeline"
import { contextSliceToMessages, stableMessageOf } from "../src/harness/context/assemble"
import { MODES } from "../src/agent/mode-contract"
import { formatModePrompt } from "../src/agent/mode-contract"
import { buildPlanStateContext } from "../src/agent/context-epoch"
import type { ContextRequest } from "../src/harness/contracts/context"
import type { ProviderMessage } from "../src/provider/types"

// H10 byte-frozen regression: the pipeline output must be byte-identical to
// the legacy in-loop assembly (plan §3.5 + §23). The legacy reference lives
// here after request-builder deprecation.

const SAVED_FLASH_TRIAGE = process.env.ORCANA_FLASH_TRIAGE
process.env.ORCANA_FLASH_TRIAGE = "off"

const stableMemoryContext = "## M0 Base Checkpoint\nDecision: keep cache prefix stable"

function buildRequest(overrides: Partial<ContextRequest> = {}): ContextRequest {
  return {
    round: 0,
    effectivePrompt: "hello",
    contextMax: 1000,
    langInstruction: "The user is using English. Reply in English only.",
    frozenStablePrefixContent: null,
    stableMemoryContext,
    experienceContext: "## Experience\nlearned",
    contextKernel: { hash: "h1", text: "kernel-text", estimatedTokens: 10, sections: [] },
    contextMapContext: "## Context Map\nmap-text",
    triageSkillPrompts: ["skill-prompt-1"],
    planState: {
      masterPlan: null,
      taskTracker: null,
      taskPacket: null,
      rippleObligations: [],
      userGoal: "hello",
      decisions: [],
      round: 0,
    },
    researchContextContent: "## Research Evidence Context\nresearch",
    stagedContext: undefined,
    thinkingStore: undefined,
    knowledgeBase: undefined,
    taskTracker: null,
    mode: MODES.coder,
    rawMessages: [{ role: "user", content: "hello" }],
    epochState: {
      currentEpochIndex: 0,
      rolloverCount: 0,
      thresholds: { forceCompressChars: 0, compressChars: 0, rolloverChars: 0 },
      epochStartRound: 0,
      snapshots: [],
      totalCharsTrimmed: 0,
    },
    ...overrides,
  }
}

/** The legacy in-loop assembly (reference implementation). */
function legacyMessages(request: ContextRequest): ProviderMessage[] {
  const stablePrefixParts: string[] = []
  if (request.stableMemoryContext?.trim()) stablePrefixParts.push(`## Stable Cold Memory\n${request.stableMemoryContext.trim()}`)
  if (request.experienceContext) stablePrefixParts.push(request.experienceContext)
  if (request.contextKernel?.text) stablePrefixParts.push(`## Project Context Kernel\n${request.contextKernel.text}`)
  if (request.contextMapContext) stablePrefixParts.push(request.contextMapContext)
  if (request.triageSkillPrompts.length) stablePrefixParts.push(request.triageSkillPrompts.join("\n\n"))
  const frozen: ProviderMessage | null = request.frozenStablePrefixContent
    ? { role: "user", content: request.frozenStablePrefixContent }
    : stablePrefixParts.length > 0
      ? { role: "user", content: ["## Stable Prefix Context\n[CACHE_ANCHOR:v3]", stablePrefixParts.join("\n\n")].join("\n\n") }
      : null

  const planStateText = buildPlanStateContext(request.planState)
  const planStateContext: ProviderMessage | null = planStateText.length > 0 ? { role: "user", content: planStateText } : null

  const volatileContext: ProviderMessage | null = request.stagedContext
    ? { role: "user", content: "## Volatile Round Context\n\nstaged" }
    : null

  const planningContext: ProviderMessage | null = request.taskTracker?.phase === "planning"
    ? { role: "user", content: "planning-prompt" }
    : null

  // Inlined legacy buildContextMessages: lang first, then stable prefix
  // (cacheable), then research/volatile/planning; mode pushed last.
  const messages: ProviderMessage[] = [
    { role: "user", content: request.langInstruction },
    ...(frozen ? [frozen] : []),
    ...(planStateContext ? [planStateContext] : []),
    ...(request.researchContextContent ? [{ role: "user" as const, content: request.researchContextContent }] : []),
    ...(volatileContext ? [volatileContext] : []),
    ...(planningContext ? [planningContext] : []),
  ]
  const modeContext = formatModePrompt(request.mode)
  if (modeContext) messages.push({ role: "user", content: modeContext })
  return messages
}

describe("H10 byte-frozen equivalence", () => {
  test("pipeline output equals the legacy assembly for a full request", async () => {
    const request = buildRequest()
    const slice = await runContextPipeline({
      providers: createDefaultContextProviders(),
      request,
    })
    expect(JSON.stringify(contextSliceToMessages(slice))).toBe(JSON.stringify(legacyMessages(request)))
  })

  test("frozen prefix round (≥1) passes the stable message through byte-for-byte", async () => {
    const frozen = "## Stable Prefix Context\n[CACHE_ANCHOR:v3]\n\n## Stable Cold Memory\nfrozen-content"
    const request = buildRequest({ round: 2, frozenStablePrefixContent: frozen })
    const slice = await runContextPipeline({
      providers: createDefaultContextProviders(),
      request,
    })
    expect(JSON.stringify(contextSliceToMessages(slice))).toBe(JSON.stringify(legacyMessages(request)))
    expect(stableMessageOf(slice)?.content).toBe(frozen)
  })

  test("round-0 stable message is persisted and reused identically on round 1", async () => {
    const round0 = buildRequest()
    const slice0 = await runContextPipeline({ providers: createDefaultContextProviders(), request: round0 })
    const frozen = stableMessageOf(slice0)
    expect(frozen).not.toBeNull()

    const round1 = buildRequest({ round: 1, frozenStablePrefixContent: typeof frozen?.content === "string" ? frozen.content : null })
    const slice1 = await runContextPipeline({ providers: createDefaultContextProviders(), request: round1 })
    expect(JSON.stringify(stableMessageOf(slice1))).toBe(JSON.stringify(frozen))
  })
})

describe("H10 round-level regression (through agentLoop)", () => {
  class CaptureProvider {
    systems: string[] = []
    messages: ProviderMessage[][] = []
    async *streamChat(options: { system?: string; messages: ProviderMessage[] }): AsyncGenerator<{ type: "text"; data: string }> {
      this.systems.push(options.system ?? "")
      this.messages.push(options.messages)
      yield { type: "text", data: "done" }
    }
  }

  test("main-round messages keep the legacy structure and stable prefix", async () => {
    const provider = new CaptureProvider()
    for await (const _event of agentLoop("hello", {
      provider: provider as never,
      model: "test",
      tools: [],
      maxRounds: 1,
      stableMemoryContext,
    })) {
      // drain
    }
    const messages = provider.messages[0]!
    // lang instruction first, then the stable prefix (cache prefix order)
    expect(String(messages[0]!.content)).toContain("Reply in English only.")
    expect(String(messages[1]!.content)).toContain("[CACHE_ANCHOR:v3]")
    expect(String(messages[1]!.content)).toContain("Stable Cold Memory")
    expect(String(messages[2]!.content)).toContain("Plan State")
    const mode = messages[messages.length - 2]
    expect(String(mode!.content)).toContain("当前模式")
    expect(String(messages[messages.length - 1]!.content)).toBe("hello")
  })
})
