/** Tests for ProviderCapabilities — PR-6.2 capability declarations and queries. */
import { describe, expect, test } from "bun:test"
import { ProviderRegistry } from "../src/provider/registry"
import type { ModelCapabilities, LLMProvider, ProviderCallOptions, StreamEvent } from "../src/provider/types"
import { toModelSpec, toModelCapabilities, toThinkingCapability } from "../src/provider/capabilities"
import type { ProviderCapabilities, ModelConfig, ProviderConfig } from "../src/config/config-schema"

// ── Mock provider for testing ──

function mockProvider(): LLMProvider {
  return {
    async *streamChat(_opts: ProviderCallOptions): AsyncGenerator<StreamEvent> {
      yield { type: "done" }
    },
  }
}

function makeRegistry(withBuiltins = true): ProviderRegistry {
  const r = new ProviderRegistry()
  r.register({ id: "deepseek", provider: mockProvider(), defaultModel: "deepseek-v4-pro" })
  r.register({ id: "anthropic", provider: mockProvider(), defaultModel: "claude-sonnet-4-6" })
  r.register({ id: "openai", provider: mockProvider(), defaultModel: "gpt-5" })
  if (withBuiltins) r.registerBuiltinModels()
  return r
}

// ── Registration and capability presence ──

describe("ProviderRegistry — capabilities on built-in models", () => {
  test("all built-in models have capabilities declared", () => {
    const r = makeRegistry()
    for (const spec of r.allModels) {
      expect(spec.capabilities).toBeDefined()
      const cap = spec.capabilities
      expect(typeof cap.thinking).toBe("boolean")
      expect(typeof cap.fim).toBe("boolean")
      expect(typeof cap.contextCaching).toBe("boolean")
      expect(typeof cap.vision).toBe("boolean")
      expect(typeof cap.structuredOutput).toBe("boolean")
      expect(typeof cap.toolUse).toBe("boolean")
      expect(typeof cap.streaming).toBe("boolean")
      expect(typeof cap.maxContextWindow).toBe("number")
    }
  })

  test("deepseek-v4-pro has thinking, fim, and context caching", () => {
    const r = makeRegistry()
    const cap = r.getCapabilities("deepseek-v4-pro")!
    expect(cap.thinking).toBe(true)
    expect(cap.fim).toBe(true)
    expect(cap.contextCaching).toBe(true)
    expect(cap.vision).toBe(false)
    expect(cap.structuredOutput).toBe(true)
  })

  test("deepseek-v4-flash has thinking", () => {
    const r = makeRegistry()
    const cap = r.getCapabilities("deepseek-v4-flash")!
    expect(cap.thinking).toBe(true)
    expect(cap.fim).toBe(true) // same provider, still has FIM
  })

  test("anthropic models have thinking, vision, but no FIM", () => {
    const r = makeRegistry()
    const cap = r.getCapabilities("claude-sonnet-4-6")!
    expect(cap.thinking).toBe(true)
    expect(cap.fim).toBe(false)
    expect(cap.vision).toBe(true)
    expect(cap.contextCaching).toBe(true)
  })

  test("claude-haiku-4-5 does NOT have thinking", () => {
    const r = makeRegistry()
    const cap = r.getCapabilities("claude-haiku-4-5")!
    expect(cap.thinking).toBe(false)
  })

  test("gpt-5 has structured output but no FIM or context caching", () => {
    const r = makeRegistry()
    const cap = r.getCapabilities("gpt-5")!
    expect(cap.thinking).toBe(false)
    expect(cap.fim).toBe(false)
    expect(cap.contextCaching).toBe(false)
    expect(cap.vision).toBe(true)
    expect(cap.structuredOutput).toBe(true)
  })
})

// ── getCapabilities ──

describe("getCapabilities", () => {
  test("returns undefined for unknown model", () => {
    const r = makeRegistry()
    expect(r.getCapabilities("nonexistent-model")).toBeUndefined()
  })

  test("returns capabilities via alias resolution", () => {
    const r = makeRegistry()
    r.registerAlias("pro", "deepseek-v4-pro")
    const cap = r.getCapabilities("pro")!
    expect(cap.thinking).toBe(true)
  })

  test("getProviderCapabilities returns provider-level capabilities", () => {
    const r = new ProviderRegistry()
    r.register({
      id: "test-provider",
      provider: mockProvider(),
      defaultModel: "test-model",
      capabilities: {
        thinking: true,
        fim: false,
        contextCaching: true,
        vision: false,
        structuredOutput: false,
        toolUse: true,
        streaming: true,
        maxContextWindow: 128_000,
      },
    })
    const cap = r.getProviderCapabilities("test-provider")
    expect(cap).toBeDefined()
    expect(cap!.thinking).toBe(true)
  })

  test("getProviderCapabilities returns undefined for unknown provider", () => {
    const r = makeRegistry()
    expect(r.getProviderCapabilities("nonexistent")).toBeUndefined()
  })
})

// ── listModelsByCapability ──

describe("listModelsByCapability", () => {
  test("finds models with thinking capability", () => {
    const r = makeRegistry()
    const models = r.listModelsByCapability({ thinking: true })
    expect(models.length).toBeGreaterThanOrEqual(3) // deepseek-v4-pro, claude-opus-4-7, claude-sonnet-4-6
    expect(models).toContain("deepseek-v4-pro")
    expect(models).toContain("deepseek-v4-flash")
    expect(models).toContain("claude-opus-4-7")
    expect(models).not.toContain("claude-haiku-4-5")
  })

  test("finds models with FIM capability", () => {
    const r = makeRegistry()
    const models = r.listModelsByCapability({ fim: true })
    // Only DeepSeek models have FIM
    expect(models.length).toBe(2)
    expect(models).toContain("deepseek-v4-pro")
    expect(models).toContain("deepseek-v4-flash")
  })

  test("finds models with vision capability", () => {
    const r = makeRegistry()
    const models = r.listModelsByCapability({ vision: true })
    // Anthropic models + GPT-5
    expect(models).toContain("claude-opus-4-7")
    expect(models).toContain("claude-sonnet-4-6")
    expect(models).toContain("gpt-5")
    expect(models).not.toContain("deepseek-v4-pro")
  })

  test("finds models with structured output", () => {
    const r = makeRegistry()
    const models = r.listModelsByCapability({ structuredOutput: true })
    // DeepSeek V4 and GPT-5 support API-level structured output.
    expect(models).toContain("deepseek-v4-pro")
    expect(models).toContain("deepseek-v4-flash")
    expect(models).toContain("gpt-5")
  })

  test("multiple capability requirements (AND logic)", () => {
    const r = makeRegistry()
    const models = r.listModelsByCapability({ thinking: true, fim: true })
    expect(models).toContain("deepseek-v4-pro")
    expect(models).toContain("deepseek-v4-flash")
    expect(models).not.toContain("claude-opus-4-7") // no FIM
  })

  test("empty requirements returns all models", () => {
    const r = makeRegistry()
    const models = r.listModelsByCapability({})
    expect(models.length).toBe(6)
  })
})

// ── modelHasCapability ──

describe("modelHasCapability", () => {
  test("returns true when all requirements match", () => {
    const r = makeRegistry()
    expect(r.modelHasCapability("deepseek-v4-pro", { fim: true, thinking: true })).toBe(true)
  })

  test("returns false when one requirement mismatches", () => {
    const r = makeRegistry()
    expect(r.modelHasCapability("deepseek-v4-flash", { vision: true })).toBe(false)
  })

  test("returns false for unknown model", () => {
    const r = makeRegistry()
    expect(r.modelHasCapability("unknown-model", { thinking: true })).toBe(false)
  })
})

// ── Capability presets are correct ──

describe("capability presets consistency", () => {
  test("all models have toolUse and streaming as true", () => {
    const r = makeRegistry()
    for (const spec of r.allModels) {
      expect(spec.capabilities.toolUse).toBe(true)
      expect(spec.capabilities.streaming).toBe(true)
    }
  })

  test("contextWindow matches capability maxContextWindow for built-in models", () => {
    const r = makeRegistry()
    for (const spec of r.allModels) {
      expect(spec.capabilities.maxContextWindow).toBe(spec.contextWindow)
    }
  })
})

// ── toModelCapabilities ──
describe("toModelCapabilities", () => {
  test("returns defaults for undefined caps", () => {
    const cap = toModelCapabilities(undefined)
    expect(cap.toolUse).toBe(false)
    expect(cap.streaming).toBe(true)  // default true
    expect(cap.thinking).toBe(false)
    expect(cap.fim).toBe(false)
    expect(cap.maxContextWindow).toBe(128_000)
  })

  test("maps supports* fields correctly", () => {
    const caps: Partial<ProviderCapabilities> = {
      supportsToolCalls: true,
      supportsStreaming: false,
      supportsJsonMode: true,
      supportsThinking: true,
      supportsFim: true,
      supportsPrefixCache: true,
      supportsVision: true,
      maxContextTokens: 200_000,
    }
    const cap = toModelCapabilities(caps)
    expect(cap.toolUse).toBe(true)
    expect(cap.streaming).toBe(false)
    expect(cap.structuredOutput).toBe(true)
    expect(cap.thinking).toBe(true)
    expect(cap.fim).toBe(true)
    expect(cap.contextCaching).toBe(true)
    expect(cap.vision).toBe(true)
    expect(cap.maxContextWindow).toBe(200_000)
  })
})

// ── toThinkingCapability ──
describe("toThinkingCapability", () => {
  test("unsupported thinking returns supported=false and empty effortLevels", () => {
    const tc = toThinkingCapability({ supportsThinking: false })
    expect(tc.supported).toBe(false)
    expect(tc.effortLevels).toEqual([])
  })

  test("supportsThinking without reasoningEffort returns [high]", () => {
    const tc = toThinkingCapability({ supportsThinking: true, supportsReasoningEffort: false })
    expect(tc.supported).toBe(true)
    expect(tc.effortLevels).toEqual(["high"])
  })

  test("supportsThinking with reasoningEffort returns [high, max]", () => {
    const tc = toThinkingCapability({ supportsThinking: true, supportsReasoningEffort: true })
    expect(tc.supported).toBe(true)
    expect(tc.effortLevels).toEqual(["high", "max"])
  })

  test("undefined caps returns unsupported", () => {
    const tc = toThinkingCapability(undefined)
    expect(tc.supported).toBe(false)
  })
})

// ── toModelSpec ──
describe("toModelSpec", () => {
  // helper to build a minimal ProviderConfig
  function makeProviderConfig(type: ProviderConfig["type"]): ProviderConfig {
    return { type, models: {} }
  }

  test("builds ModelSpec with correct id and providerId", () => {
    const providerConfig = makeProviderConfig("deepseek")
    const modelConfig: ModelConfig = { displayName: "Test Model" }
    const spec = toModelSpec("test-model", "deepseek", modelConfig, providerConfig)
    expect(spec.id).toBe("test-model")
    expect(spec.providerId).toBe("deepseek")
    expect(spec.displayName).toBe("Test Model")
    expect(spec.isDefault).toBe(false)
  })

  test("falls back to modelId when displayName is not set", () => {
    const providerConfig = makeProviderConfig("deepseek")
    const modelConfig: ModelConfig = {}
    const spec = toModelSpec("my-model", "deepseek", modelConfig, providerConfig)
    expect(spec.displayName).toBe("my-model")
  })

  test("infers pricingTier from provider type (ollama → free)", () => {
    const providerConfig = makeProviderConfig("ollama")
    const spec = toModelSpec("llama3", "ollama", {}, providerConfig)
    expect(spec.pricingTier).toBe("free")
  })

  test("infers pricingTier from provider type (deepseek → cheap)", () => {
    const providerConfig = makeProviderConfig("deepseek")
    const spec = toModelSpec("ds-chat", "deepseek", {}, providerConfig)
    expect(spec.pricingTier).toBe("cheap")
  })

  test("infers pricingTier from provider type (openrouter → standard)", () => {
    const providerConfig = makeProviderConfig("openrouter")
    const spec = toModelSpec("or-model", "openrouter", {}, providerConfig)
    expect(spec.pricingTier).toBe("standard")
  })

  test("uses contextWindow from ModelConfig when provided", () => {
    const providerConfig = makeProviderConfig("deepseek")
    const modelConfig: ModelConfig = { contextWindow: 64_000 }
    const spec = toModelSpec("m", "deepseek", modelConfig, providerConfig)
    expect(spec.contextWindow).toBe(64_000)
  })

  test("falls back to maxContextTokens from capabilities when contextWindow not set", () => {
    const providerConfig = makeProviderConfig("deepseek")
    const modelConfig: ModelConfig = {
      capabilities: { maxContextTokens: 256_000 } as Partial<ProviderCapabilities>,
    }
    const spec = toModelSpec("m", "deepseek", modelConfig, providerConfig)
    expect(spec.contextWindow).toBe(256_000)
  })

  test("infers tags from capabilities", () => {
    const providerConfig = makeProviderConfig("deepseek")
    const modelConfig: ModelConfig = {
      capabilities: {
        supportsThinking: true,
        supportsFim: true,
        supportsToolCalls: true,
      } as Partial<ProviderCapabilities>,
    }
    const spec = toModelSpec("m", "deepseek", modelConfig, providerConfig)
    expect(spec.tags).toContain("thinking")
    expect(spec.tags).toContain("reasoning")
    expect(spec.tags).toContain("fim")
    expect(spec.tags).toContain("coding")
    expect(spec.tags).toContain("tools")
    expect(spec.tags).toContain("agent")
  })

  test("adds general tag when no capabilities match", () => {
    const providerConfig = makeProviderConfig("ollama")
    const spec = toModelSpec("m", "ollama", {}, providerConfig)
    expect(spec.tags).toContain("general")
    expect(spec.tags.length).toBe(1)
  })
})
