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

  test("skips an oversized newest message instead of evicting the entire older history", () => {
    const history = [
      { role: "user" as const, content: "u".repeat(6) },
      { role: "assistant" as const, content: "a".repeat(1_000) },
    ]
    expect(selectRecentHistoryWithinBudget(history, 100, 3, 60).map(m => m.content)).toEqual([
      "uuuuuu",
    ])
  })

  test("skips an oversized message but still includes older short constraint messages", () => {
    const history = [
      { role: "user" as const, content: "HARD CONSTRAINT: never touch schema" },
      { role: "assistant" as const, content: "a".repeat(1_000) },
      { role: "user" as const, content: "newer user message" },
      { role: "assistant" as const, content: "newer assistant message" },
    ]
    const selected = selectRecentHistoryWithinBudget(history, 30, 3, 60)
    expect(selected.map(m => m.content)).toEqual([
      "HARD CONSTRAINT: never touch schema",
      "newer user message",
      "newer assistant message",
    ])
  })

  test("includes all messages when they fit within the budget", () => {
    const history = [
      { role: "user" as const, content: "one" },
      { role: "assistant" as const, content: "two" },
      { role: "user" as const, content: "three" },
      { role: "assistant" as const, content: "four" },
    ]
    expect(selectRecentHistoryWithinBudget(history, 50, 3, 60)).toEqual(history)
  })

  test("returns an empty array when even a single message exceeds a tiny budget", () => {
    const history = [
      { role: "user" as const, content: "short" },
      { role: "assistant" as const, content: "tiny" },
    ]
    expect(selectRecentHistoryWithinBudget(history, 1, 3, 60)).toEqual([])
  })
})

describe("resolveMaxRounds", () => {
  test("uses runtime default unless explicitly configured", () => {
    expect(resolveMaxRounds(undefined, undefined)).toBe(50)
    expect(resolveMaxRounds(undefined, "75")).toBe(75)
    expect(resolveMaxRounds(30, "75")).toBe(30)
  })
})
