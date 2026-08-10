import { describe, expect, test } from "bun:test"
import { buildRoundProviderRequest, cacheStableProviderTools, estimateRoundTokens } from "../src/agent/round/request-builder"
import { CacheTracker } from "../src/provider/cache-tracker"
import { buildTools, Result } from "../src/tools/registry"

function makeTools(count: number) {
  return buildTools(...Array.from({ length: count }, (_, index) => ({
    name: `tool_${index}`,
    description: `Tool ${index}`,
    isReadonly: index % 2 === 0,
    inputSchema: { type: "object", properties: {} },
    execute() {
      return Result.ok("ok")
    },
  })))
}

describe("Round request builder", () => {
  test("keeps cache-stable provider tools in original order", () => {
    const tools = makeTools(3)

    expect(cacheStableProviderTools(tools).map(tool => tool.defn.name)).toEqual([
      "tool_0",
      "tool_1",
      "tool_2",
    ])
  })

  test("builds provider schemas, cache shape, and estimated usage event", () => {
    const cacheTracker = new CacheTracker()
    const tools = makeTools(2)

    const request = buildRoundProviderRequest({
      modelName: "deepseek-test",
      system: "system",
      providerMessages: [{ role: "user", content: "hello" }],
      tools,
      cacheTracker,
      thinkingTokenTotal: 3,
      contextInputTotal: 100,
      contextOutputTotal: 7,
      contextMax: 1000,
      round: 0,
      contextUsagePercent: 10,
    })

    expect(request.providerToolSchemas.map(schema => schema.name)).toEqual(["tool_0", "tool_1"])
    expect(request.cacheStatus).toBe("miss")
    expect(request.cacheShape.sections.some(section => section.kind === "tools")).toBe(true)
    expect(request.estimatedUsageEvent.cacheSource).toBe("estimate")
    expect(request.estimatedUsageEvent.inputTokens).toBe(100)
    expect(request.estimatedUsageEvent.cacheAnatomy.sections.some(section => section.kind === "tools")).toBe(true)
  })

  test("caps provider-visible tool schemas at 128", () => {
    const request = buildRoundProviderRequest({
      modelName: "deepseek-test",
      system: "system",
      providerMessages: [{ role: "user", content: "hello" }],
      tools: makeTools(130),
      cacheTracker: new CacheTracker(),
      thinkingTokenTotal: 0,
      contextInputTotal: 1,
      contextOutputTotal: 0,
      contextMax: 1000,
      round: 0,
      contextUsagePercent: 1,
    })

    expect(request.providerToolSchemas).toHaveLength(128)
    expect(request.providerToolSchemas.at(-1)?.name).toBe("tool_127")
  })

  test("tool schemas are counted in the round token budget", () => {
    const system = "system prompt"
    const messages: Array<{ role: "user"; content: string }> = [{ role: "user", content: "hello" }]
    const withoutTools = estimateRoundTokens(system, [], messages, null)
    const withTools = estimateRoundTokens(system, [], messages, null, makeTools(10))

    expect(withTools.roundInputTokens).toBeGreaterThan(withoutTools.roundInputTokens)
  })

  test("tool schema budget estimate applies the same 128 cap as disclosure", () => {
    const system = "system prompt"
    const messages: Array<{ role: "user"; content: string }> = [{ role: "user", content: "hello" }]
    const estimate128 = estimateRoundTokens(system, [], messages, null, makeTools(128))
    const estimate300 = estimateRoundTokens(system, [], messages, null, makeTools(300))

    expect(estimate300.roundInputTokens).toBe(estimate128.roundInputTokens)
  })

  test("budget matches the disclosed tool subset, not the full set", () => {
    const system = "system prompt"
    const messages: Array<{ role: "user"; content: string }> = [{ role: "user", content: "hello" }]
    const disclosed = estimateRoundTokens(system, [], messages, null, makeTools(10))
    const full = estimateRoundTokens(system, [], messages, null, makeTools(50))

    expect(disclosed.roundInputTokens).toBeLessThan(full.roundInputTokens)
  })
})
