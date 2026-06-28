import { describe, expect, test } from "bun:test"
import { FlashTriage, resolveFlashTriagePolicy, shouldUseFlashTriage } from "./flash-triage"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../provider/types"

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

class CountingProvider implements LLMProvider {
  calls = 0
  options: ProviderCallOptions[] = []

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.calls += 1
    this.options.push(options)
    yield { type: "text", data: '{"mode":"discussion","needsWeb":false,"researchQueries":[],"relevantSkillNames":[],"planSteps":[],"requiredVerification":[],"reasoning":"ok","riskLevel":"low"}' }
  }
}

describe("FlashTriage cost policy", () => {
  test("resolves explicit Flash triage policies", () => {
    expect(resolveFlashTriagePolicy(undefined)).toBe("auto")
    expect(resolveFlashTriagePolicy("0")).toBe("off")
    expect(resolveFlashTriagePolicy("auto")).toBe("auto")
    expect(resolveFlashTriagePolicy("1")).toBe("always")
    expect(resolveFlashTriagePolicy("always")).toBe("always")
  })

  test("auto policy skips trivial continuations, fires for meaningful prompts", () => {
    expect(shouldUseFlashTriage("off", "build a full-stack app")).toBe(false)
    expect(shouldUseFlashTriage("always", "hi")).toBe(true)

    // trivial continuations → skip
    expect(shouldUseFlashTriage("auto", "好")).toBe(false)
    expect(shouldUseFlashTriage("auto", "继续")).toBe(false)
    expect(shouldUseFlashTriage("auto", "ok")).toBe(false)

    // meaningful prompts → fire semantic
    expect(shouldUseFlashTriage("auto", "帮我分析这个架构")).toBe(true)
    expect(shouldUseFlashTriage("auto", "帮我跑一下 bun test 看看有没有失败的")).toBe(true)
    expect(shouldUseFlashTriage("auto", "帮我设计 Context Map Pipeline 的技术方案，不需要实现")).toBe(true)
    expect(shouldUseFlashTriage("auto", "你觉得这个 Agent 架构怎么样")).toBe(true)

    // very short but with project context → fire
    expect(shouldUseFlashTriage("auto", "修复它", "src/agent/loop.ts\nsrc/agent/intent.ts")).toBe(true)

    // very short, no context → skip
    expect(shouldUseFlashTriage("auto", "修复它")).toBe(false) // 3 chars < 8 threshold
    expect(shouldUseFlashTriage("auto", "hi", "")).toBe(false) // <8 chars, no context
  })

  test("strict mode skips the Flash triage provider call", async () => {
    const old = process.env.DEEPSEEK_COST_MODE
    const provider = new CountingProvider()
    try {
      process.env.DEEPSEEK_COST_MODE = "strict"
      const triage = new FlashTriage(provider)
      const result = await triage.triage("build a small app", "package.json")
      expect(result).toBeNull()
      expect(provider.calls).toBe(0)
    } finally {
      restoreEnv("DEEPSEEK_COST_MODE", old)
    }
  })

  test("normal mode labels Flash triage calls with purpose", async () => {
    const old = process.env.DEEPSEEK_COST_MODE
    const provider = new CountingProvider()
    try {
      delete process.env.DEEPSEEK_COST_MODE
      const triage = new FlashTriage(provider)
      const result = await triage.triage("build a small app", "package.json")
      expect(result?.mode).toBe("discussion")
      expect(provider.calls).toBe(1)
      expect(provider.options[0]?.purpose).toBe("flash_triage")
    } finally {
      restoreEnv("DEEPSEEK_COST_MODE", old)
    }
  })
})
