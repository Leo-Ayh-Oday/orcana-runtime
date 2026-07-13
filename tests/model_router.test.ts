/** Tests for ModelRouter purpose routing — PR-6.1. */
import { describe, expect, test } from "bun:test"
import { ModelRouter } from "../src/provider/router"
import { ProviderRegistry } from "../src/provider/registry"
import { MultiProvider } from "../src/provider/multi"
import type { LLMProvider, ProviderCallOptions, StreamEvent, ProviderCallPurpose } from "../src/provider/types"

// ── Mock provider ──

function mockProvider(): LLMProvider {
  return {
    async *streamChat(_opts: ProviderCallOptions): AsyncGenerator<StreamEvent> {
      yield { type: "done" }
    },
  }
}

function makeStack() {
  const registry = new ProviderRegistry()
  registry.register({ id: "deepseek", provider: mockProvider(), defaultModel: "deepseek-v4-pro" })
  registry.register({ id: "anthropic", provider: mockProvider(), defaultModel: "claude-sonnet-4-6" })
  registry.register({ id: "openai", provider: mockProvider(), defaultModel: "gpt-5" })
  registry.registerBuiltinModels()
  const multi = new MultiProvider({ registry, defaultModel: "deepseek-v4-pro" })
  const router = new ModelRouter(registry, multi)
  return { registry, multi, router }
}

// ── Purpose routing ──

describe("ModelRouter — purpose routing", () => {
  test("agent_main returns session-pinned model", () => {
    const { router } = makeStack()
    const model = router.selectForPurpose("agent_main")
    expect(model).toBe("deepseek-v4-pro")
  })

  test("flash_triage routes to cheap model", () => {
    const { router } = makeStack()
    const model = router.selectForPurpose("flash_triage")
    expect(model).toBe("deepseek-v4-flash")
  })

  test("completion_judge routes to cheap model", () => {
    const { router } = makeStack()
    const model = router.selectForPurpose("completion_judge")
    expect(model).toBe("deepseek-v4-flash")
  })

  test("plan_judge routes to cheap model", () => {
    const { router } = makeStack()
    const model = router.selectForPurpose("plan_judge")
    expect(model).toBe("deepseek-v4-flash")
  })

  test("ambiguity_detector routes to cheap model", () => {
    const { router } = makeStack()
    const model = router.selectForPurpose("ambiguity_detector")
    expect(model).toBe("deepseek-v4-flash")
  })

  test("clarification returns session-pinned model (not cheap)", () => {
    const { router } = makeStack()
    const model = router.selectForPurpose("clarification")
    expect(model).toBe("deepseek-v4-pro")
  })

  test("chat_lite returns session-pinned model (not cheap)", () => {
    const { router } = makeStack()
    const model = router.selectForPurpose("chat_lite")
    expect(model).toBe("deepseek-v4-pro")
  })

  test("unknown returns session-pinned model", () => {
    const { router } = makeStack()
    const model = router.selectForPurpose("unknown")
    expect(model).toBe("deepseek-v4-pro")
  })

  test("session model is cached and consistent", () => {
    const { router } = makeStack()
    const a = router.getSessionModel()
    const b = router.getSessionModel()
    expect(a).toBe(b)
    expect(a).toBe("deepseek-v4-pro")
  })
})

describe("MultiProvider — explicit model routing", () => {
  test("adapts Claude Opus 4.7 to adaptive thinking without a manual budget", async () => {
    let forwardedThinking: ProviderCallOptions["thinking"]
    const provider: LLMProvider = {
      async *streamChat(opts: ProviderCallOptions): AsyncGenerator<StreamEvent> {
        forwardedThinking = opts.thinking
        yield { type: "done" }
      },
    }
    const registry = new ProviderRegistry()
    registry.register({ id: "anthropic", provider, defaultModel: "claude-opus-4-7" })
    registry.registerBuiltinModels()
    const multi = new MultiProvider({ registry, defaultModel: "claude-opus-4-7" })

    for await (const _event of multi.streamChat({
      model: "claude-opus-4-7",
      system: "",
      messages: [{ role: "user", content: "analyze" }],
      maxTokens: 16_384,
      thinking: { type: "enabled", budget_tokens: 32_768, effort: "max" },
    })) { /* consume */ }

    expect(forwardedThinking).toEqual({ type: "adaptive", effort: "max" })
  })

  test("keeps manual Anthropic thinking budget below maxTokens", async () => {
    let forwardedThinking: ProviderCallOptions["thinking"]
    const provider: LLMProvider = {
      async *streamChat(opts: ProviderCallOptions): AsyncGenerator<StreamEvent> {
        forwardedThinking = opts.thinking
        yield { type: "done" }
      },
    }
    const registry = new ProviderRegistry()
    registry.register({ id: "anthropic", provider, defaultModel: "claude-manual" })
    registry.registerModel({
      id: "claude-manual",
      providerId: "anthropic",
      displayName: "Claude Manual",
      contextWindow: 200_000,
      maxOutputTokens: 16_384,
      pricingTier: "standard",
      thinking: { supported: true, mode: "manual", maxBudgetTokens: 32_768, effortLevels: ["high", "max"] },
      capabilities: { thinking: true, fim: false, contextCaching: true, vision: false, structuredOutput: false, toolUse: true, streaming: true, maxContextWindow: 200_000 },
      tags: ["reasoning"],
      isDefault: true,
    })
    const multi = new MultiProvider({ registry, defaultModel: "claude-manual" })

    for await (const _event of multi.streamChat({
      model: "claude-manual",
      system: "",
      messages: [{ role: "user", content: "analyze" }],
      maxTokens: 6_144,
      thinking: { type: "enabled", budget_tokens: 16_384, effort: "high" },
    })) { /* consume */ }

    expect(forwardedThinking?.budget_tokens).toBeLessThan(6_144)
    expect(forwardedThinking?.budget_tokens).toBeGreaterThanOrEqual(1_024)
  })


  test("honors the model selected by the caller for cheap sub-calls", async () => {
    let actualModel = ""
    const provider: LLMProvider = {
      async *streamChat(opts: ProviderCallOptions): AsyncGenerator<StreamEvent> {
        actualModel = opts.model
        yield { type: "done" }
      },
    }
    const registry = new ProviderRegistry()
    registry.register({ id: "deepseek", provider, defaultModel: "deepseek-v4-pro" })
    registry.registerBuiltinModels()
    const multi = new MultiProvider({ registry, defaultModel: "deepseek-v4-pro" })

    for await (const _event of multi.streamChat({
      model: "deepseek-v4-flash",
      purpose: "flash_triage",
      system: "",
      messages: [{ role: "user", content: "classify" }],
      maxTokens: 32,
    })) {
      // Consume the routed provider stream.
    }

    expect(actualModel).toBe("deepseek-v4-flash")
  })
})

// ── Cheap model logic ──

describe("ModelRouter — cheap model selection", () => {
  test("getCheapModel returns cheapest fast-tagged model", () => {
    const { router } = makeStack()
    expect(router.getCheapModel()).toBe("deepseek-v4-flash")
  })

  test("getCheapModel is cached after first call", () => {
    const { router } = makeStack()
    const first = router.getCheapModel()
    const second = router.getCheapModel()
    expect(first).toBe(second)
  })

  test("getCheapModel falls back to session model when no cheap model exists", () => {
    const registry = new ProviderRegistry()
    registry.register({ id: "deepseek", provider: mockProvider(), defaultModel: "deepseek-v4-pro" })
    // Register only pro model, no flash
    registry.registerModel({
      id: "deepseek-v4-pro",
      providerId: "deepseek",
      displayName: "DeepSeek V4 Pro",
      contextWindow: 1_048_576,
      maxOutputTokens: 32768,
      pricingTier: "standard",
      thinking: { supported: true, maxBudgetTokens: 32768, defaultBudget: 16384, effortLevels: ["high", "max"] },
      capabilities: { thinking: true, fim: true, contextCaching: true, vision: false, structuredOutput: false, toolUse: true, streaming: true, maxContextWindow: 1_048_576 },
      tags: ["coding", "reasoning"],
      isDefault: true,
    })
    const multi = new MultiProvider({ registry, defaultModel: "deepseek-v4-pro" })
    const router = new ModelRouter(registry, multi)

    // No "fast"-tagged model → fallback to session model
    expect(router.getCheapModel()).toBe("deepseek-v4-pro")
  })
})

// ── Purpose routing can be disabled ──

describe("ModelRouter — purpose routing disabled", () => {
  test("all purposes return session model when routing is off", () => {
    const { registry, multi } = makeStack()
    const router = new ModelRouter(registry, multi, { purposeRouting: false })

    const purposes: ProviderCallPurpose[] = [
      "agent_main", "flash_triage", "completion_judge", "plan_judge",
      "clarification", "unknown", "ambiguity_detector",
    ]
    for (const p of purposes) {
      expect(router.selectForPurpose(p)).toBe("deepseek-v4-pro")
    }
  })
})

// ── Static helpers ──

describe("ModelRouter — static helpers", () => {
  test("isCheapPurpose returns true for cheap purposes", () => {
    expect(ModelRouter.isCheapPurpose("flash_triage")).toBe(true)
    expect(ModelRouter.isCheapPurpose("completion_judge")).toBe(true)
    expect(ModelRouter.isCheapPurpose("plan_judge")).toBe(true)
    expect(ModelRouter.isCheapPurpose("ambiguity_detector")).toBe(true)
    expect(ModelRouter.isCheapPurpose("thinking_compaction")).toBe(true)
    expect(ModelRouter.isCheapPurpose("semantic_recall_score")).toBe(true)
    expect(ModelRouter.isCheapPurpose("knowledge_distill")).toBe(true)
    expect(ModelRouter.isCheapPurpose("cold_memory_audit")).toBe(true)
  })

  test("isCheapPurpose returns false for main purposes", () => {
    expect(ModelRouter.isCheapPurpose("agent_main")).toBe(false)
    expect(ModelRouter.isCheapPurpose("clarification")).toBe(false)
    expect(ModelRouter.isCheapPurpose("chat_lite")).toBe(false)
    expect(ModelRouter.isCheapPurpose("unknown")).toBe(false)
  })
})

// ── createProviderStack integration ──

describe("ModelRouter — createProviderStack", () => {
  test("stack factory wires registry + multi + router", async () => {
    const { createProviderStack } = await import("../src/provider/router")
    const stack = createProviderStack(
      [
        { id: "deepseek", provider: mockProvider(), defaultModel: "deepseek-v4-pro" },
        { id: "anthropic", provider: mockProvider(), defaultModel: "claude-sonnet-4-6" },
      ],
      "deepseek-v4-pro",
    )
    expect(stack.registry).toBeDefined()
    expect(stack.multi).toBeDefined()
    expect(stack.router).toBeDefined()
    expect(stack.router.getSessionModel()).toBe("deepseek-v4-pro")
    expect(stack.router.selectForPurpose("flash_triage")).toBe("deepseek-v4-flash")
  })
})
