/** RC-19 Phase 4 fault baseline — Context Measurement Authority.
 *
 *  Invariants:
 *    K48 TOKEN_ESTIMATE_UNIFIED  — one TokenAccountingService; no module does
 *        its own chars/3 or chars/2.5 arithmetic.
 *    K49 TOOL_SCHEMA_IN_BUDGET   — tool schemas count toward the request budget
 *        (register: fixed at bb9a1d3 — regression lock).
 *    NEW CONVERSATION_TAIL_ACCOUNTING — the real conversation tail is counted
 *        in the ContextManifest / budget; `content:"" estimatedTokens:0`
 *        metadata-only tails are forbidden.
 *
 *  Measurement only — no active trimming (ACTIVE_CONTEXT_TRIM = OFF).
 */

import { describe, expect, test } from "bun:test"
import { estimateRoundTokens } from "../../src/agent/round/request-builder"
import { CONVERSATION_TAIL_PROVIDER } from "../../src/harness/context/providers/volatile"
import { buildTools } from "../../src/tools/registry"

// ── K49 regression: schemas already count toward the estimate (fixed) ──

describe("K49 TOOL_SCHEMA_IN_BUDGET (regression lock)", () => {
  test("estimateRoundTokens counts tool schema characters", () => {
    const tools = buildTools({
      name: "schema_heavy_tool",
      description: "a tool with a verbose schema description that takes many characters",
      inputSchema: {
        type: "object",
        properties: {
          alpha: { type: "string", description: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
          beta: { type: "integer", description: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
        },
      },
      execute: async () => ({ success: true, content: "ok" }),
    })
    const withTools = estimateRoundTokens("system", [], [{ role: "user", content: "hi" }], null, tools)
    const withoutTools = estimateRoundTokens("system", [], [{ role: "user", content: "hi" }], null, [])
    expect(withTools.roundInputTokens).toBeGreaterThan(withoutTools.roundInputTokens)
  })
})

// ── K48: unified service exists and is the single estimator ──

describe("K48 TOKEN_ESTIMATE_UNIFIED", () => {
  test("TokenAccountingService is importable from the accounting module", async () => {
    const { TokenAccountingService } = await import("../../src/context-runtime/accounting/token-accounting")
    expect(typeof TokenAccountingService).toBe("function")
  })

  test("estimateRequest reports the full budget split (text/message/schema/system/total)", async () => {
    const { TokenAccountingService } = await import("../../src/context-runtime/accounting/token-accounting")
    const service = new TokenAccountingService()
    const estimate = service.estimateRequest({
      system: "you are a helpful assistant",
      messages: [{ role: "user", content: "hello" }],
      toolSchemas: [{ name: "t", inputSchema: { type: "object", properties: {} } }],
    })
    expect(estimate.totalInputTokens).toBeGreaterThan(0)
    expect(estimate.toolSchemaTokens).toBeGreaterThan(0)
    expect(estimate.textTokens + estimate.messageTokens + estimate.toolSchemaTokens + estimate.systemTokens)
      .toBe(estimate.totalInputTokens)
  })

  test("request-builder estimate delegates to the unified service (no local /3)", async () => {
    const { TokenAccountingService } = await import("../../src/context-runtime/accounting/token-accounting")
    const service = new TokenAccountingService()
    const { estimateRoundTokens } = await import("../../src/context-runtime/accounting/estimate-delegates")
    // The production entry must be the service-backed delegate — a module that
    // re-implements /3 on its own is a K48 violation.
    const viaService = service.estimateRequest({
      system: "s",
      messages: [{ role: "user", content: "hello world" }],
      toolSchemas: [],
    })
    const viaDelegate = estimateRoundTokens("s", [], [{ role: "user", content: "hello world" }], null, [])
    expect(Math.abs(viaService.totalInputTokens - viaDelegate.roundInputTokens)).toBeLessThanOrEqual(
      Math.max(2, Math.round(viaService.totalInputTokens * 0.05)),
    )
  })

  test("calibration: observeActualUsage drives the EMA factor and error stays bounded", async () => {
    const { TokenAccountingService } = await import("../../src/context-runtime/accounting/token-accounting")
    const service = new TokenAccountingService()
    // Feed observations of a provider whose real density is 2.5 chars/token:
    // the estimate must converge (P50 error <= 10%, P95 <= 20%).
    const errors: number[] = []
    for (let i = 0; i < 20; i++) {
      const content = "用户消息与中文文本混排" + "x".repeat(200) + `#${i}`
      const estimate = service.estimateRequest({
        system: "系统提示词内容",
        messages: [{ role: "user", content }],
        toolSchemas: [],
      })
      const actualTokens = Math.round(("系统提示词内容".length + content.length) / 2.5)
      errors.push(Math.abs(estimate.totalInputTokens - actualTokens) / actualTokens)
      service.observeActualUsage({ provider: "deepseek-v4-flash", model: "deepseek-v4", actualTokens })
    }
    errors.sort((a, b) => a - b)
    const p50 = errors[Math.floor(errors.length / 2)]!
    const p95 = errors[Math.floor(errors.length * 0.95)]!
    expect(p50).toBeLessThanOrEqual(0.10)
    expect(p95).toBeLessThanOrEqual(0.20)
  })
})

// ── NEW: conversation tail must be accounted, not metadata-only ──

describe("CONVERSATION_TAIL_ACCOUNTING", () => {
  test("conversation-tail provider reports real estimated tokens for non-empty tails", async () => {
    const tail = await CONVERSATION_TAIL_PROVIDER.provide({
      rawMessages: [
        { role: "user", content: "最近几轮的真实对话内容" },
        { role: "assistant", content: "assistant reply" },
      ],
      epochState: { currentEpochIndex: 0 },
    } as never)
    expect(tail.estimatedTokens).toBeGreaterThan(0)
    expect(tail.content.length).toBeGreaterThan(0)
  })
})
