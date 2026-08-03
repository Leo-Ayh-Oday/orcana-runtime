import { describe, expect, test } from "bun:test"
import { renderStartupScreen } from "../src/ui/startup-screen"

describe("startup screen fallback", () => {
  test("renders the wide DeepSeek banner with runtime facts", () => {
    const out = renderStartupScreen({
      version: "0.3.0",
      toolsCount: 19,
      thinkingEffort: "auto",
      modelName: "deepseek-v4-pro",
      columns: 120,
    })

    expect(out).toContain("██████╗")
    expect(out).toContain("Orcana")
    expect(out).toContain("Hraness runtime")
    expect(out).toContain("deepseek-v4-pro")
    expect(out).toContain("19")
    expect(out).toContain("/sessions")
  })

  test("falls back to compact copy on narrow terminals", () => {
    const out = renderStartupScreen({
      version: "0.3.0",
      toolsCount: 19,
      thinkingEffort: "high",
      modelName: "deepseek-v4-pro",
      columns: 60,
    })

    expect(out).toContain("sonar first / verify always")
    expect(out).toContain("high")
    expect(out).not.toContain("██████╗")
  })
})
