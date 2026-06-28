/** Tests for DeepSeekTranscriptManager — PR-6.3. */
import { describe, expect, test } from "bun:test"
import {
  DeepSeekTranscriptManager,
  hasUnclosedToolChain,
  hasAdjacencyViolation,
  countToolsInLastAssistantTurn,
} from "../src/provider/transcript-manager"
import type { ProviderMessage } from "../src/provider/types"

// ── Helpers ──

function assistant(content: Array<Record<string, unknown>>): ProviderMessage {
  return { role: "assistant", content }
}

function user(content: Array<Record<string, unknown>>): ProviderMessage {
  return { role: "user", content }
}

function textUser(text: string): ProviderMessage {
  return { role: "user", content: text }
}

function toolUse(id: string, name: string): Record<string, unknown> {
  return { type: "tool_use", id, name, input: {} }
}

function toolResult(id: string, output: string): Record<string, unknown> {
  return { type: "tool_result", tool_use_id: id, content: output }
}

function thinkingBlock(text: string): Record<string, unknown> {
  return { type: "thinking", thinking: text }
}

// ── hasUnclosedToolChain ──

describe("hasUnclosedToolChain", () => {
  test("empty messages — no unclosed chain", () => {
    expect(hasUnclosedToolChain([])).toBe(false)
  })

  test("single assistant with tool_use — unclosed", () => {
    expect(hasUnclosedToolChain([
      assistant([toolUse("1", "read_file")]),
    ])).toBe(true)
  })

  test("tool_use followed by tool_result — closed", () => {
    expect(hasUnclosedToolChain([
      assistant([toolUse("1", "read_file")]),
      user([toolResult("1", "content")]),
    ])).toBe(false)
  })

  test("multiple tool_use followed by matching tool_results — closed", () => {
    expect(hasUnclosedToolChain([
      assistant([toolUse("1", "read_file"), toolUse("2", "write_file")]),
      user([toolResult("1", "ok"), toolResult("2", "ok")]),
    ])).toBe(false)
  })

  test("two tool_use but only one tool_result — unclosed", () => {
    expect(hasUnclosedToolChain([
      assistant([toolUse("1", "read_file"), toolUse("2", "write_file")]),
      user([toolResult("1", "ok")]),
    ])).toBe(true)
  })

  test("assistant without tool_use — no chain", () => {
    expect(hasUnclosedToolChain([
      assistant([{ type: "text", text: "hello" }]),
    ])).toBe(false)
  })

  test("text-only messages — no chain", () => {
    expect(hasUnclosedToolChain([
      textUser("hello"),
      assistant([{ type: "text", text: "hi" }]),
    ])).toBe(false)
  })

  test("multiple rounds of tool use all closed", () => {
    expect(hasUnclosedToolChain([
      assistant([toolUse("1", "read")]),
      user([toolResult("1", "data")]),
      assistant([toolUse("2", "write")]),
      user([toolResult("2", "ok")]),
    ])).toBe(false)
  })
})

// ── hasAdjacencyViolation ──

describe("hasAdjacencyViolation", () => {
  test("no violation when tool_use followed by tool_result", () => {
    expect(hasAdjacencyViolation([
      assistant([toolUse("1", "read")]),
      user([toolResult("1", "data")]),
    ])).toBe(false)
  })

  test("violation when assistant tool_use followed by user without tool_result", () => {
    expect(hasAdjacencyViolation([
      assistant([toolUse("1", "read")]),
      textUser("some text without tool result"),
    ])).toBe(true)
  })

  test("no violation when text message between non-tool messages", () => {
    expect(hasAdjacencyViolation([
      assistant([{ type: "text", text: "hello" }]),
      textUser("reply"),
    ])).toBe(false)
  })

  test("no violation for empty messages", () => {
    expect(hasAdjacencyViolation([])).toBe(false)
  })

  test("no violation for single message", () => {
    expect(hasAdjacencyViolation([assistant([toolUse("1", "read")])])).toBe(false)
  })
})

// ── countToolsInLastAssistantTurn ──

describe("countToolsInLastAssistantTurn", () => {
  test("counts tools in last assistant message", () => {
    expect(countToolsInLastAssistantTurn([
      assistant([toolUse("1", "read"), toolUse("2", "write")]),
    ])).toBe(2)
  })

  test("returns 0 when no assistant messages", () => {
    expect(countToolsInLastAssistantTurn([
      textUser("hello"),
    ])).toBe(0)
  })

  test("only counts last assistant turn", () => {
    expect(countToolsInLastAssistantTurn([
      assistant([toolUse("1", "read"), toolUse("2", "write"), toolUse("3", "grep")]),
      user([toolResult("1", "a"), toolResult("2", "b"), toolResult("3", "c")]),
      assistant([toolUse("4", "write")]), // last turn — only 1 tool
    ])).toBe(1)
  })
})

// ── DeepSeekTranscriptManager ──

describe("DeepSeekTranscriptManager", () => {
  const tm = new DeepSeekTranscriptManager()

  describe("canEpochRollover", () => {
    test("allows rollover when all chains closed", () => {
      expect(tm.canEpochRollover([
        assistant([toolUse("1", "read")]),
        user([toolResult("1", "ok")]),
      ])).toBe(true)
    })

    test("blocks rollover when unclosed chain exists", () => {
      expect(tm.canEpochRollover([
        assistant([toolUse("1", "read")]),
      ])).toBe(false)
    })
  })

  describe("validateTranscript", () => {
    test("valid transcript passes", () => {
      const result = tm.validateTranscript([
        assistant([toolUse("1", "read")]),
        user([toolResult("1", "ok")]),
      ])
      expect(result.valid).toBe(true)
      expect(result.unclosedChain).toBe(false)
      expect(result.adjacencyViolation).toBe(false)
    })

    test("unclosed chain is detected", () => {
      const result = tm.validateTranscript([
        assistant([toolUse("1", "read")]),
      ])
      expect(result.valid).toBe(false)
      expect(result.unclosedChain).toBe(true)
      expect(result.reason).toContain("unclosed")
    })

    test("adjacency violation is reported", () => {
      const result = tm.validateTranscript([
        assistant([toolUse("1", "read")]),
        textUser("no tool result here"),
      ])
      expect(result.valid).toBe(false)
      expect(result.adjacencyViolation).toBe(true)
    })

    test("tool counts are accurate", () => {
      const result = tm.validateTranscript([
        assistant([toolUse("1", "a"), toolUse("2", "b")]),
        user([toolResult("1", "x"), toolResult("2", "y")]),
      ])
      expect(result.toolUseCount).toBe(2)
      expect(result.toolResultCount).toBe(2)
    })
  })

  describe("computeStats", () => {
    test("counts messages correctly", () => {
      const stats = tm.computeStats([
        textUser("hello"),
        assistant([{ type: "text", text: "hi" }]),
      ])
      expect(stats.messageCount).toBe(2)
      expect(stats.assistantMessages).toBe(1)
      expect(stats.userMessages).toBe(1)
      expect(stats.toolUseBlocks).toBe(0)
    })

    test("counts tool_use and tool_result blocks", () => {
      const stats = tm.computeStats([
        assistant([toolUse("1", "read"), toolUse("2", "grep")]),
        user([toolResult("1", "a"), toolResult("2", "b")]),
      ])
      expect(stats.toolUseBlocks).toBe(2)
      expect(stats.toolResultBlocks).toBe(2)
    })

    test("counts thinking blocks", () => {
      const stats = tm.computeStats([
        assistant([thinkingBlock("let me think..."), { type: "text", text: "answer" }]),
      ])
      expect(stats.thinkingBlocks).toBe(1)
      expect(stats.textBlocks).toBe(1)
    })

    test("counts tools in last turn", () => {
      const stats = tm.computeStats([
        assistant([toolUse("1", "read")]),
        user([toolResult("1", "ok")]),
        assistant([toolUse("2", "write"), toolUse("3", "edit")]),
      ])
      expect(stats.toolsInLastTurn).toBe(2)
    })

    test("counts chars in string content", () => {
      const stats = tm.computeStats([
        { role: "user", content: "hello world" },
      ])
      expect(stats.totalChars).toBe(11)
    })
  })

  describe("checkToolLimit", () => {
    test("passes when tools are under limit", () => {
      const result = tm.checkToolLimit([
        assistant([toolUse("1", "read")]),
      ])
      expect(result.ok).toBe(true)
      expect(result.count).toBe(1)
      expect(result.limit).toBe(128)
    })

    test("passes with no tools", () => {
      const result = tm.checkToolLimit([
        textUser("hello"),
      ])
      expect(result.ok).toBe(true)
      expect(result.count).toBe(0)
    })
  })

  describe("formatStats", () => {
    test("returns compact stats string", () => {
      const s = tm.formatStats([
        textUser("hello"),
        assistant([{ type: "text", text: "hi" }]),
      ])
      expect(s).toContain("[transcript:")
      expect(s).toContain("2 msgs")
    })

    test("includes tool counts when present", () => {
      const s = tm.formatStats([
        assistant([toolUse("1", "read")]),
        user([toolResult("1", "ok")]),
      ])
      expect(s).toContain("tools:")
      expect(s).toContain("use")
    })
  })
})
