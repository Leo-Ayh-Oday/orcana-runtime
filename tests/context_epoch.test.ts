/** Tests for Context Epoch (PR 4). */

import { describe, it, expect } from "bun:test"
import {
  createEpochState,
  DEFAULT_EPOCH_THRESHOLDS,
  msgCharLen,
  totalMessageChars,
  buildPlanStateContext,
  hasUnclosedToolChain,
  classifyEpochAction,
  epochRollover,
  formatEpochBudgetWarning,
  formatEpochStatus,
  type EpochThresholds,
  type PlanStateInput,
} from "../src/agent/context-epoch"
import type { ProviderMessage } from "../src/provider/types"

// ── Helpers ──

function msg(role: "user" | "assistant", content: string): ProviderMessage {
  return { role, content }
}

function assistantWithTools(toolIds: string[]): ProviderMessage {
  return {
    role: "assistant",
    content: toolIds.map(id => ({ type: "tool_use", id, name: "read_file", input: {} })),
  }
}

function userWithResults(toolIds: string[]): ProviderMessage {
  return {
    role: "user",
    content: toolIds.map(id => ({ type: "tool_result", tool_use_id: id, content: "ok" })),
  }
}

// ── msgCharLen & totalMessageChars ──

describe("msgCharLen", () => {
  it("counts string content", () => {
    expect(msgCharLen({ role: "user", content: "hello" })).toBe(5)
  })

  it("counts JSON content", () => {
    const m: ProviderMessage = { role: "user", content: [{ type: "text", text: "hi" }] }
    expect(msgCharLen(m)).toBe(JSON.stringify([{ type: "text", text: "hi" }]).length)
  })
})

describe("totalMessageChars", () => {
  it("sums across messages", () => {
    const messages = [msg("user", "abc"), msg("assistant", "def")]
    expect(totalMessageChars(messages)).toBe(6)
  })

  it("returns 0 for empty array", () => {
    expect(totalMessageChars([])).toBe(0)
  })
})

// ── classifyEpochAction ──

describe("classifyEpochAction", () => {
  const t: EpochThresholds = { compressChars: 100, forceCompressChars: 200, rolloverChars: 300 }

  it("returns none below compress threshold", () => {
    expect(classifyEpochAction(50, t)).toBe("none")
  })

  it("returns compress at compress threshold", () => {
    expect(classifyEpochAction(100, t)).toBe("compress")
  })

  it("returns forceCompress at forceCompress threshold", () => {
    expect(classifyEpochAction(200, t)).toBe("forceCompress")
  })

  it("returns rollover at rollover threshold", () => {
    expect(classifyEpochAction(300, t)).toBe("rollover")
  })

  it("returns rollover above rollover threshold", () => {
    expect(classifyEpochAction(500, t)).toBe("rollover")
  })
})

// ── hasUnclosedToolChain ──

describe("hasUnclosedToolChain", () => {
  it("returns false for empty messages", () => {
    expect(hasUnclosedToolChain([])).toBe(false)
  })

  it("returns false for text-only messages", () => {
    expect(hasUnclosedToolChain([msg("user", "hi"), msg("assistant", "hello")])).toBe(false)
  })

  it("returns false when all tool_use have tool_result", () => {
    const msgs = [
      msg("user", "task"),
      assistantWithTools(["tool1"]),
      userWithResults(["tool1"]),
    ]
    expect(hasUnclosedToolChain(msgs)).toBe(false)
  })

  it("returns true when tool_use has no tool_result", () => {
    const msgs = [
      msg("user", "task"),
      assistantWithTools(["tool1"]),
    ]
    expect(hasUnclosedToolChain(msgs)).toBe(true)
  })

  it("returns true with mixed closed and unclosed", () => {
    const msgs = [
      msg("user", "round 1"),
      assistantWithTools(["a"]),
      userWithResults(["a"]),
      msg("user", "round 2"),
      assistantWithTools(["b", "c"]),
      userWithResults(["b"]),
      // c has no result
    ]
    expect(hasUnclosedToolChain(msgs)).toBe(true)
  })

  it("returns false with multiple rounds fully closed", () => {
    const msgs = [
      msg("user", "r1"),
      assistantWithTools(["a"]),
      userWithResults(["a"]),
      msg("user", "r2"),
      assistantWithTools(["b"]),
      userWithResults(["b"]),
    ]
    expect(hasUnclosedToolChain(msgs)).toBe(false)
  })
})

// ── createEpochState ──

describe("createEpochState", () => {
  it("creates with defaults", () => {
    const state = createEpochState()
    expect(state.currentEpochIndex).toBe(0)
    expect(state.rolloverCount).toBe(0)
    expect(state.snapshots).toEqual([])
    expect(state.totalCharsTrimmed).toBe(0)
    expect(state.thresholds.compressChars).toBe(120_000)
  })

  it("overrides thresholds", () => {
    const state = createEpochState({ compressChars: 50_000 })
    expect(state.thresholds.compressChars).toBe(50_000)
    // rest stay default
    expect(state.thresholds.rolloverChars).toBe(300_000)
  })
})

// ── buildPlanStateContext ──

describe("buildPlanStateContext", () => {
  it("includes user goal", () => {
    const input: PlanStateInput = {
      masterPlan: null, taskTracker: null, taskPacket: null,
      rippleObligations: [], userGoal: "实现登录功能", decisions: [], round: 1,
    }
    const text = buildPlanStateContext(input)
    expect(text).toContain("实现登录功能")
    expect(text).toContain("[EPOCH_ANCHOR:v1]")
  })

  it("includes plan summary", () => {
    const plan = {
      id: "plan1", goal: "test", intent: "long_task" as const,
      nodes: [
        { id: "1", title: "Node 1", status: "done" as const, dependsOn: [], blockedBy: [], tracker: null },
        { id: "2", title: "Node 2", status: "active" as const, dependsOn: [], blockedBy: [], tracker: null, _packet: { verification: [], doneCriteria: [], scope: [] } },
        { id: "3", title: "Node 3", status: "pending" as const, dependsOn: [], blockedBy: [], tracker: null },
      ],
      createdAt: Date.now(),
      _lastValidation: null,
    } as any
    const input: PlanStateInput = {
      masterPlan: plan, taskTracker: null, taskPacket: null,
      rippleObligations: [], userGoal: "test", decisions: [], round: 1,
    }
    const text = buildPlanStateContext(input)
    expect(text).toContain("3 nodes, 1 done")
    expect(text).toContain('"Node 2"')
    expect(text).toContain('"Node 3"')
  })

  it("includes ripple obligations", () => {
    const obligations = [
      { targetFile: "a.ts", symbol: "foo", caller: {} as any, reason: "ripple verify" },
      { targetFile: "b.test.ts", symbol: "bar", caller: {} as any, reason: "ripple test" },
    ] as any[]
    const input: PlanStateInput = {
      masterPlan: null, taskTracker: null, taskPacket: null,
      rippleObligations: obligations, userGoal: "test", decisions: [], round: 1,
    }
    const text = buildPlanStateContext(input)
    expect(text).toContain("2 pending")
  })

  it("includes decisions", () => {
    const input: PlanStateInput = {
      masterPlan: null, taskTracker: null, taskPacket: null,
      rippleObligations: [],
      userGoal: "test",
      decisions: ["使用 Redis 缓存", "API v2 端点"],
      round: 1,
    }
    const text = buildPlanStateContext(input)
    expect(text).toContain("Redis 缓存")
    expect(text).toContain("API v2")
  })

  it("handles empty everything", () => {
    const input: PlanStateInput = {
      masterPlan: null, taskTracker: null, taskPacket: null,
      rippleObligations: [], userGoal: "", decisions: [], round: 1,
    }
    const text = buildPlanStateContext(input)
    expect(text).toContain("[EPOCH_ANCHOR:v1]")
    // Should not crash
    expect(text.length).toBeGreaterThan(0)
  })

  it("includes task tracker steps", () => {
    const tracker = {
      goal: "build API",
      phase: "building",
      requiredFiles: ["src/api.ts"],
      steps: [
        { id: "1", title: "create route", status: "done" },
        { id: "2", title: "add handler", status: "running" },
      ],
    } as any
    const input: PlanStateInput = {
      masterPlan: null, taskTracker: tracker, taskPacket: null,
      rippleObligations: [], userGoal: "test", decisions: [], round: 1,
    }
    const text = buildPlanStateContext(input)
    expect(text).toContain("1/2 steps")
    expect(text).toContain("add handler")
  })

  it("includes taskPacket scope and doneCriteria", () => {
    const packet = {
      taskId: "t1", nodeId: "1", title: "API", goal: "build API",
      scope: ["src/api.ts", "src/handler.ts"],
      doneCriteria: ["API 响应 200", "typecheck pass"],
      verification: [{ kind: "typecheck", description: "tsc" }],
      ripplePolicy: { autoPropagate: true, requireEvidence: true, maxRetries: 3 },
      contextBudget: { maxToolsPerNode: 20, maxRoundsPerNode: 8, estimatedTokens: 50_000 },
    }
    const input: PlanStateInput = {
      masterPlan: null, taskTracker: null, taskPacket: packet as any,
      rippleObligations: [], userGoal: "test", decisions: [], round: 1,
    }
    const text = buildPlanStateContext(input)
    expect(text).toContain("src/api.ts")
    expect(text).toContain("API 响应 200")
  })
})

// ── epochRollover ──

describe("epochRollover", () => {
  it("blocks when unclosed tool chain exists", () => {
    const messages = [
      msg("user", "task"),
      assistantWithTools(["t1"]),
    ]
    const state = createEpochState()
    const result = epochRollover(messages, 2, "plan state", state, 10)
    expect("blocked" in result).toBe(true)
    if ("blocked" in result) {
      expect(result.reason).toContain("unclosed tool-use")
    }
  })

  it("archives old messages and keeps recent", () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0
        ? msg("user", `round ${i / 2} text here for length padding xxxxxxxxxxxxxxxxxxxxxx`)
        : msg("assistant", `response ${i / 2} with some length xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`)
    )
    const state = createEpochState()
    const result = epochRollover(messages, 3, "plan state context", state, 10)
    expect("blocked" in result).toBe(false)
    if (!("blocked" in result)) {
      expect(result.archivedCount).toBeGreaterThan(0)
      expect(result.charsTrimmed).toBeGreaterThan(0)
      expect(result.messages.length).toBeLessThan(messages.length)
      // Preamble should contain plan state
      const preamble = result.messages[0]!
      expect(typeof preamble.content).toBe("string")
      if (typeof preamble.content === "string") {
        expect(preamble.content).toContain("plan state context")
        expect(preamble.content).toContain("Epoch Rollover")
      }
    }
  })

  it("retains at least 2 messages at tail", () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      i % 2 === 0
        ? msg("user", `round ${i} xxxxxxxxxxxxxxxxxxxxxxxxxxxx`)
        : msg("assistant", `response ${i} xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`)
    )
    const state = createEpochState()
    const result = epochRollover(messages, 1, "ps", state, 10)
    if (!("blocked" in result)) {
      // keepRecent=1 with 10 alternating messages → 1 retained + preamble = 2 total
      expect(result.messages.length).toBeGreaterThanOrEqual(2)
    }
  })

  it("updates state snapshots", () => {
    const messages = Array.from({ length: 12 }, (_, i) =>
      i % 2 === 0
        ? msg("user", `msg${i} xxxxxxxxxxxxxxxxxxxxxxxxxxxx`)
        : msg("assistant", `msg${i} xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`)
    )
    const state = createEpochState()
    const result = epochRollover(messages, 2, "ps", state, 15)
    if (!("blocked" in result)) {
      expect(result.snapshot.index).toBe(0)
      expect(result.snapshot.endRound).toBe(15)
      expect(result.snapshot.messageCountBefore).toBe(12)
    }
  })

  it("returns correct charsTrimmed", () => {
    const state = createEpochState()
    const longText = "x".repeat(200)
    const messages = [
      msg("user", longText),
      msg("assistant", longText),
      msg("user", longText),
      msg("assistant", longText),
      msg("user", longText),
      msg("assistant", longText),
      msg("user", longText),
      msg("assistant", longText),
    ]
    const result = epochRollover(messages, 1, "ps", state, 10)
    if (!("blocked" in result)) {
      // charsTrimmed = charsBefore - charsAfter, where charsAfter is retainedMessages only
      const retained = result.messages.slice(1) // skip preamble
      const expectedTrimmed = totalMessageChars(messages) - totalMessageChars(retained)
      expect(result.charsTrimmed).toBe(expectedTrimmed)
    }
  })
})

// ── formatEpochBudgetWarning ──

describe("formatEpochBudgetWarning", () => {
  it("includes percentage", () => {
    const text = formatEpochBudgetWarning(73, DEFAULT_EPOCH_THRESHOLDS)
    expect(text).toContain("73%")
  })

  it("includes threshold info", () => {
    const text = formatEpochBudgetWarning(50, DEFAULT_EPOCH_THRESHOLDS)
    expect(text).toContain("120k")
    expect(text).toContain("220k")
    expect(text).toContain("300k")
  })
})

// ── formatEpochStatus ──

describe("formatEpochStatus", () => {
  it("returns compact status line", () => {
    const state = createEpochState()
    const status = formatEpochStatus(state, 5, 50_000)
    expect(status).toContain("epoch: 0")
    expect(status).toContain("round: 5")
    expect(status).toContain("chars: 50000")
    expect(status).toContain("action: none")
  })

  it("shows rollover action when threshold reached", () => {
    const state = createEpochState()
    const status = formatEpochStatus(state, 20, 350_000)
    expect(status).toContain("action: rollover")
  })
})

// ── DEFAULT_EPOCH_THRESHOLDS ──

describe("DEFAULT_EPOCH_THRESHOLDS", () => {
  it("has ordered thresholds", () => {
    expect(DEFAULT_EPOCH_THRESHOLDS.compressChars).toBeLessThan(DEFAULT_EPOCH_THRESHOLDS.forceCompressChars)
    expect(DEFAULT_EPOCH_THRESHOLDS.forceCompressChars).toBeLessThan(DEFAULT_EPOCH_THRESHOLDS.rolloverChars)
  })
})
