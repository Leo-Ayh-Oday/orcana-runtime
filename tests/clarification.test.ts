import { describe, expect, test } from "bun:test"
import { agentLoop } from "../src/agent/loop"
import {
  CLARIFICATION_MARKER,
  buildEffectivePrompt,
  evaluateClarificationNeed,
  findPendingClarification,
  parseModelClarification,
} from "../src/agent/clarification"
import { createTaskTracker } from "../src/agent/task-tracker"
import { classifyIntent } from "../src/agent/intent"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../src/provider/types"

const MODEL_CLARIFICATION = [
  CLARIFICATION_MARKER,
  '{"questions":[{"id":"1","title":"What visual style should the blog use?","options":[{"key":"A","label":"Minimal editorial","recommended":true},{"key":"B","label":"Magazine-like"},{"key":"C","label":"Personal brand"}]},{"id":"2","title":"What is the first release scope?","options":[{"key":"A","label":"Posts and reading","recommended":true},{"key":"B","label":"Posts, tags and search"},{"key":"C","label":"Posts, admin and auth"}]},{"id":"3","title":"How should we verify it?","options":[{"key":"A","label":"Smoke test only"},{"key":"B","label":"Typecheck, test and build","recommended":true},{"key":"C","label":"Visual QA too"}]}],"extraPrompt":"Anything else you want to tell Orcana?"}',
].join("\n")

class ModelClarificationProvider implements LLMProvider {
  calls = 0
  allOptions: ProviderCallOptions[] = []
  chunks: string[]

  constructor(chunks = [MODEL_CLARIFICATION]) {
    this.chunks = chunks
  }

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.calls += 1
    this.allOptions.push(options)
    for (const chunk of this.chunks) yield { type: "text", data: chunk }
  }
}

class FailingClarificationProvider implements LLMProvider {
  calls = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.calls += 1
    throw new Error("provider unavailable")
  }
}

describe("Clarification gate", () => {
  test("emits structured model clarification before vague long tasks reach implementation", async () => {
    const provider = new ModelClarificationProvider([
      MODEL_CLARIFICATION.slice(0, 90),
      MODEL_CLARIFICATION.slice(90),
    ])
    const events: StreamEvent[] = []

    for await (const event of agentLoop("Build a full-stack personal blog", {
      provider,
      model: "test",
      tools: [],
      maxRounds: 2,
      flashTriagePolicy: "off",
    })) {
      events.push(event)
    }

    const clarificationEvents = events.filter(event => event.type === "clarification_ready")
    const usageEvents = events.filter(event => event.type === "token_usage")
    const structured = clarificationEvents[0]?.data as ReturnType<typeof parseModelClarification>

    expect(provider.calls).toBeGreaterThanOrEqual(1)
    expect(provider.allOptions.length).toBeGreaterThanOrEqual(1)
    expect(usageEvents.length).toBeGreaterThanOrEqual(1)
    expect(clarificationEvents.length).toBe(1)
    expect(structured?.marker).toBe(CLARIFICATION_MARKER)
    expect(structured?.questions.length).toBeGreaterThanOrEqual(1)
  })

  test("parses model clarification questions and recommended defaults", () => {
    const parsed = parseModelClarification(MODEL_CLARIFICATION, "Build a full-stack personal blog")

    expect(parsed?.originalPrompt).toBe("Build a full-stack personal blog")
    expect(parsed?.questions.length).toBeGreaterThanOrEqual(1)
    expect(parsed?.questions[0]?.title.length).toBeGreaterThan(0)
    expect(parsed?.questions[0]?.options.length).toBeGreaterThanOrEqual(2)
  })

  test("does not emit a hardcoded fallback when model clarification fails", async () => {
    const provider = new FailingClarificationProvider()
    const events: StreamEvent[] = []

    for await (const event of agentLoop("Build a full-stack personal blog", {
      provider,
      model: "test",
      tools: [],
      maxRounds: 2,
    })) {
      events.push(event)
    }

    const error = events.filter(event => event.type === "error").map(event => String(event.data ?? "")).join("\n")
    expect(provider.calls).toBeGreaterThanOrEqual(1)
    expect(error).toContain("Clarification failed")
  })

  test("does not ask again after the user answers a clarification request", () => {
    const original = "Build a full-stack personal blog"
    const request = [
      CLARIFICATION_MARKER,
      '{"questions":[{"id":"1","title":"Style?","options":[{"key":"A","label":"Minimal"},{"key":"B","label":"Editorial"},{"key":"C","label":"Branded"}]}]}',
    ].join("\n")
    const history = [
      { role: "user" as const, content: original },
      { role: "assistant" as const, content: request },
    ]

    expect(findPendingClarification(history)).toBe(original)

    const answer = "Use an editorial style with React/Vite and Bun."
    const effective = buildEffectivePrompt(answer, history)
    const nextTracker = createTaskTracker(effective, classifyIntent(effective).mode)
    const nextGate = evaluateClarificationNeed({ prompt: effective, tracker: nextTracker, history })

    expect(effective).toContain(original)
    expect(effective).toContain(answer)
    expect(nextGate.required).toBe(false)
  })
})
