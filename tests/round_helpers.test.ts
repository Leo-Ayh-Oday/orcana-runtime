import { describe, expect, test } from "bun:test"
import { resolveMaxRounds, selectRecentHistoryWithinBudget } from "../src/agent/round/helpers"

describe("selectRecentHistoryWithinBudget", () => {
  test("keeps the newest messages when history exceeds the budget", () => {
    const history = ["oldest", "older", "newer", "newest"].map((content, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: content.padEnd(9, "!"),
    }))

    expect(selectRecentHistoryWithinBudget(history, 6, 3, 60).map(item => item.content.slice(0, 6)))
      .toEqual(["newer!", "newest"])
  })

  test("returns selected messages in chronological order", () => {
    const history = [
      { role: "user" as const, content: "one" },
      { role: "assistant" as const, content: "two" },
      { role: "user" as const, content: "three" },
    ]
    expect(selectRecentHistoryWithinBudget(history, 100)).toEqual(history)
  })

  test("never starts provider history with an orphan assistant message", () => {
    const history = [
      { role: "user" as const, content: "u".repeat(20) },
      { role: "assistant" as const, content: "short" },
    ]
    expect(selectRecentHistoryWithinBudget(history, 2, 3)).toEqual([])
  })
})

describe("resolveMaxRounds", () => {
  test("uses runtime default unless explicitly configured", () => {
    expect(resolveMaxRounds(undefined, undefined)).toBe(50)
    expect(resolveMaxRounds(undefined, "75")).toBe(75)
    expect(resolveMaxRounds(30, "75")).toBe(30)
  })
})
