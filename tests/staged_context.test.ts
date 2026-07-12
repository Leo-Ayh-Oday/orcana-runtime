import { describe, expect, test } from "bun:test"
import { StagedContextManager } from "../src/context/staged"
import { formatRoundBudgetExhausted } from "../src/agent/round/helpers"

describe("StagedContextManager provider-safe clipping", () => {
  test("does not cut loaded source in the middle of a hex escape", () => {
    const staged = new StagedContextManager(process.cwd())
    staged.loadedFiles.set("terminal.ts", `${"a".repeat(3998)}\\x1B[31mrest`)

    const content = staged.buildContext().warm[0]!.content

    expect(content.endsWith("\\x")).toBe(false)
    expect(content).toContain("context clipped")
  })
})

describe("round budget exhaustion", () => {
  test("returns an explicit recoverable handoff instead of ending silently", () => {
    const message = formatRoundBudgetExhausted(30)
    expect(message).toContain("30")
    expect(message).toContain("继续")
  })
})
