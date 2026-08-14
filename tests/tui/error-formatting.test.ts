import { describe, expect, test } from "bun:test"
import { cleanAgentError } from "../../src/tui/state/adapter-helpers"
import { StreamEventAdapter } from "../../src/tui/state/event-adapter"

describe("TUI provider error formatting", () => {
  test("maps real model auth failures to the auth action message", () => {
    expect(cleanAgentError("HTTP 401 Unauthorized: invalid x-api-key")).toContain("模型服务认证失败")
    expect(cleanAgentError("Authentication failed")).toContain("模型服务认证失败")
    expect(cleanAgentError("还没有配置 deepseek 的 API key。请运行 /models，选择模型后输入 key。")).toContain("模型服务认证失败")
  })

  test("does NOT map tool/execd auth-substring errors to model auth failures", () => {
    // execd SO_PEERCRED 降级错误：含 "authenticated" 但不是模型认证 —— 必须返回原文
    expect(cleanAgentError("capacity authority requires authenticated peer (SO_PEERCRED unavailable)")).not.toContain("模型服务认证失败")
    // 文件路径含 auth 子串
    expect(cleanAgentError("read access denied: src/auth.ts")).not.toContain("模型服务认证失败")
    // 授权语义（非认证）
    expect(cleanAgentError("authorization failed: workspace write denied")).not.toContain("模型服务认证失败")
    // 无错误语义的普通文本
    expect(cleanAgentError("the auth module is at src/auth.ts")).not.toContain("模型服务认证失败")
  })

  test("does not treat bare numbers like 402 as quota failure", () => {
    expect(cleanAgentError("listen EADDRINUSE: address already in use :402")).not.toContain("额度")
  })
  test("explains truncated escape request errors as recoverable context corruption", () => {
    expect(cleanAgentError("client 400: Failed to parse request: unexpected end of hex escape")).toContain("上下文")
  })

  test("renders quota failures as a short Chinese action message", () => {
    const message = cleanAgentError("quota 429: insufficient_quota: Your account balance is too low")

    expect(message).toBe("模型服务额度或余额不足。请在 /models 切换模型、重新输入可用 key，或到对应平台充值后再试。")
  })

  test("deduplicates repeated provider errors for the scrollback", () => {
    const adapter = new StreamEventAdapter()
    const events = adapter.adapt({
      type: "error",
      data: "quota 429: insufficient_quota: Your account balance is too low",
    })

    const eventMessage = events.find(event => event.type === "ui.event_message")
    expect(eventMessage).toBeDefined()
    expect(eventMessage).toMatchObject({
      kind: "error",
      dedupeKey: "error:模型服务额度或余额不足。请在 /models 切换模型、重新输入可用 key，或到对应平台充值后再试。",
      minIntervalMs: 10_000,
    })
  })
})
