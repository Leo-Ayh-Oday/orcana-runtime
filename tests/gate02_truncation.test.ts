/**
 * GATE-02 — Provider Truncation Semantics（P0 清理线第一刀）
 *
 * 验收对照（GATES-CONTROL-PLANE-PLAN.md §GS）：
 *   GS-03  max_tokens 不得进入 generic provider retry
 *   GS-04  execution/recovery 阶段必须存在 action token reserve
 *   GS-05  已完整提交的 tool call 不得因 response truncation 丢失或重复
 *
 * OTS-013 根因链：32K thinking 意图 × 6K maxTokens → 思考烧光 envelope →
 * 截断 → 已闭合 tool block 被丢弃 → 无差别重试 → 死循环。
 */

import { describe, expect, test } from "bun:test"
import { createState, decideThinkingPlan, type RoundState } from "../src/agent/router"
import type { ThinkingProfile } from "../src/agent/router"
import {
  failureFromProviderEvent,
  isNonRetryableProviderStreamError,
} from "../src/agent/provider/failure-policy"
import { runProviderRound } from "../src/agent/provider/round-runner"
import type { ProviderRoundResult } from "../src/agent/provider/round-result"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../src/provider/types"
import { ProviderRegistry } from "../src/provider/registry"
import { MultiProvider } from "../src/provider/multi"

const ARCHITECTURE_PROMPT = `
我们要重构这个 runtime 的 router/provider/agent 层：评估架构影响、缓存与上下文管理、
安全与权限边界、事务与回滚、测试与验证门禁，还有长任务下的记忆与压缩策略。
请深度思考后给出完整方案，并自我反驳后收敛。
`

function plan(state: RoundState, profile: ThinkingProfile) {
  return decideThinkingPlan(state, undefined, profile)
}

describe("ResponseBudget invariant（GS-04）", () => {
  test("thinking budget + action reserve 恒 ≤ maxTokens（各阶段最严 reserve）", () => {
    const state = createState()
    for (const stage of ["planning", "execution", "recovery"] as const) {
      for (const prompt of [ARCHITECTURE_PROMPT, "修复一个 bug"]) {
        const d = plan(state, {
          prompt,
          intentMode: "long_task",
          planningPhase: stage === "planning",
          stage,
        })
        const budget = d.thinking?.budget_tokens ?? 0
        const maxTokens = d.maxTokens
        // 各阶段契约 reserve：planning 25% / execution 40% / recovery 50%
        const minReserve = { planning: 0.25, execution: 0.4, recovery: 0.5 }[stage]
        expect(budget).toBeLessThanOrEqual(Math.floor(maxTokens * (1 - minReserve)))
      }
    }
  })

  test("深度结构预检（32K 意图）在 execution 阶段被校准到 ~60% envelope", () => {
    const d = plan(createState(), {
      prompt: ARCHITECTURE_PROMPT,
      intentMode: "long_task",
      stage: "execution",
    })
    expect(d.thinking?.budget_tokens).toBe(9830) // floor(16384 * 0.6)
    expect(d.maxTokens).toBe(16384)
    expect(d.thinking?.effort).toBe("max")
  })

  test("planning 阶段 reserve 25%：32K 意图 → 12288", () => {
    const d = plan(createState(), {
      prompt: ARCHITECTURE_PROMPT,
      intentMode: "long_task",
      planningPhase: true,
      stage: "planning",
    })
    expect(d.thinking?.budget_tokens).toBe(12288) // floor(16384 * 0.75)
    expect(d.maxTokens).toBe(16384)
  })

  test("recovery 阶段 reserve 50%：思考减半、动作空间加倍", () => {
    const d = plan(createState(), {
      prompt: ARCHITECTURE_PROMPT,
      intentMode: "long_task",
      stage: "recovery",
    })
    expect(d.thinking?.budget_tokens).toBe(8192) // floor(16384 * 0.5)
    expect(d.maxTokens).toBe(16384)
  })
})

describe("error 不再驱动 auto-max（OTS-013 放大器拆除）", () => {
  test("consecutiveErrors=5 不触发 auto-max（只修改文件数可触发）", () => {
    const errOnly = plan(createState(), {
      prompt: ARCHITECTURE_PROMPT,
      intentMode: "long_task",
      autoMaxSignals: { consecutiveErrors: 5, modifiedFiles: 0 },
    })
    expect(errOnly.factors.includes("auto-max")).toBe(false)

    const broadEdit = plan(createState(), {
      prompt: ARCHITECTURE_PROMPT,
      intentMode: "long_task",
      autoMaxSignals: { consecutiveErrors: 0, modifiedFiles: 6 },
    })
    expect(broadEdit.factors.includes("auto-max")).toBe(true)
    // auto-max 意图 32K 也走同一 invariant
    const budget = broadEdit.thinking?.budget_tokens ?? 0
    expect(budget).toBeLessThanOrEqual(Math.floor(broadEdit.maxTokens * 0.6))
  })

  test("错误上升走 recovery 档位而非更深思考", () => {
    const state = createState()
    const recovery = plan(state, {
      prompt: ARCHITECTURE_PROMPT,
      intentMode: "long_task",
      stage: "recovery",
      autoMaxSignals: { consecutiveErrors: 5, modifiedFiles: 0 },
    })
    expect(recovery.thinking?.budget_tokens).toBe(8192) // recovery cap
  })
})

describe("envelope 不超模型 spec（审核修复）", () => {
  test("multi clamps maxTokens to the model's maxOutputTokens", async () => {
    const seen: Array<number | undefined> = []
    const provider: LLMProvider = {
      async *streamChat(opts: ProviderCallOptions): AsyncGenerator<StreamEvent> {
        seen.push(opts.maxTokens)
        yield { type: "done", data: "ok" }
      },
    }
    const registry = new ProviderRegistry()
    registry.register({ id: "test", provider, defaultModel: "tiny" })
    registry.registerModel({
      id: "tiny",
      providerId: "test",
      displayName: "Tiny",
      contextWindow: 8_000,
      maxOutputTokens: 8_192,
      pricingTier: "cheap",
      thinking: { supported: false, mode: "manual", maxBudgetTokens: 0, effortLevels: [] },
      capabilities: { thinking: false, fim: false, contextCaching: false, vision: false, structuredOutput: false, toolUse: true, streaming: true, maxContextWindow: 8_000 },
      tags: ["fast"],
    })
    const multi = new MultiProvider({ registry, defaultModel: "tiny" })
    // 超限 → 钳到 spec 上限（超限 max_tokens 会被 provider API 以校验错误
    // 拒绝 → retryable → 无限重试，即新 OTS-013 形状）
    for await (const _e of multi.streamChat({ model: "tiny", system: "", messages: [], maxTokens: 20_000 })) {}
    // 未超限 → 原样透传
    for await (const _e of multi.streamChat({ model: "tiny", system: "", messages: [], maxTokens: 4_096 })) {}
    expect(seen).toEqual([8_192, 4_096])
  })
})

describe("max_tokens 不进 generic retry（GS-03）", () => {
  test("failure-policy 将 stop_reason=max_tokens 判为 non-retryable", () => {
    expect(isNonRetryableProviderStreamError("provider stop_reason=max_tokens: response hit the output token limit before completion")).toBe(true)
    const failure = failureFromProviderEvent("provider stop_reason=max_tokens: response hit the output token limit before completion")
    expect(failure.retryable).toBe(false)
  })

  test("普通 provider 错误仍可重试", () => {
    expect(isNonRetryableProviderStreamError("transport: connection reset")).toBe(false)
    expect(isNonRetryableProviderStreamError("quota exceeded: balance")).toBe(true)
  })

  test("openai finish_reason 截断格式也进 non-retryable 兜底", () => {
    expect(isNonRetryableProviderStreamError("provider finish_reason=length: response hit the output token limit before completion")).toBe(true)
    expect(isNonRetryableProviderStreamError("provider finish_reason=max_tokens: response hit the output token limit before completion")).toBe(true)
  })

  test("truncated 事件经 round-runner 记入账本而非 failure（GS-03/GS-05）", async () => {
    const provider: LLMProvider = {
      async *streamChat(): AsyncGenerator<StreamEvent> {
        yield { type: "tool_call", data: { id: "call-1", name: "write_file", input: { path: "a.ts" } } }
        yield { type: "truncated", data: { stopReason: "max_tokens", toolCalls: 1 } }
      },
    }
    const events: StreamEvent[] = []
    const iterator = runProviderRound({
      provider,
      request: { model: "test", purpose: "agent_main", system: "s", messages: [], maxTokens: 10 },
      bufferText: true,
    })
    let result: ProviderRoundResult | undefined
    while (true) {
      const next = await iterator.next()
      if (next.done) {
        result = next.value
        break
      }
      events.push(next.value)
    }

    expect(events.some(e => e.type === "truncated")).toBe(true)
    expect(result?.stopReason).toBe("truncated")
    expect(result?.failure).toBeUndefined()
    // 截断轮的 tool call 完整入账 —— 执行器照常执行，轮次不重试
    expect(result?.toolCalls.map(tc => tc.id)).toEqual(["call-1"])
  })
})
