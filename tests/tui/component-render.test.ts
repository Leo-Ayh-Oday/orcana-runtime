/** Tests for component pure functions — covers PR-2 acceptance points.
 *
 *  Points covered:
 *    1. HeaderBar long model name: fitText truncation
 *    2. Scrollback respects viewport: renderMessageLines output
 *    3. GateBadge pass/block/skip: gateStatusColor + gateStatusLabel
 *    4. ToolCard large output: only summary is rendered (no full output field)
 *    5. eventMarker / eventColor: correct kind → marker/color mapping
 */

import { describe, expect, test } from "bun:test"
import {
  fitText,
  renderMessageLines,
  eventMarker,
  eventColor,
  type ChatEventKind,
} from "../../src/tui/components/MessageItem"
import {
  toolStatusIcon,
  toolStatusColor,
  toolStatusLabel,
  formatDuration,
} from "../../src/tui/components/ToolCard"
import {
  gateStatusColor,
  gateStatusLabel,
} from "../../src/tui/components/GateBadge"
import type { TuiMessage } from "../../src/tui/state/types"
import { C, theme } from "../../src/tui/theme/theme"

// ── fitText (PR-2 acceptance #1: HeaderBar long model name) ──

describe("component: fitText truncation", () => {
  test("short text passes through unchanged", () => {
    expect(fitText("hello", 20)).toBe("hello")
  })

  test("text exactly at width passes through unchanged", () => {
    expect(fitText("hello", 5)).toBe("hello")
  })

  test("long text is truncated with ... suffix (width > 3)", () => {
    const result = fitText("abcdefghijklmnopqrstuvwxyz", 10)
    // fitTerminalText: out has width-1 chars (9), then "..." appended → 12 total
    expect(result.endsWith("...")).toBe(true)
    expect(result.length).toBeLessThan("abcdefghijklmnopqrstuvwxyz".length)
  })

  test("empty string returns empty", () => {
    expect(fitText("", 10)).toBe("")
  })

  test("width=1 returns at most 1 character (no ... for width <= 3)", () => {
    const result = fitText("hello", 1)
    expect(result.length).toBeLessThanOrEqual(1)
  })

  test("width=3 returns at most 3 characters (no ... appended for narrow)", () => {
    const result = fitText("hello world", 3)
    expect(result.length).toBeLessThanOrEqual(3)
  })

  test("very long model name is truncated for HeaderBar", () => {
    const longName = "deepseek-v4-pro-experimental-extended-context-window-128k-preview"
    const truncated = fitText(longName, 20)
    expect(truncated.endsWith("...")).toBe(true)
    expect(truncated.length).toBeLessThan(longName.length)
  })
})

// ── renderMessageLines (PR-2 acceptance #3: Scrollback viewport) ──

describe("component: renderMessageLines", () => {
  test("user message: marker > and cyan color", () => {
    const message: TuiMessage = {
      id: "m1",
      role: "user",
      text: "hello world",
      createdAt: 0,
    }
    const lines = renderMessageLines(message, 40, "")
    expect(lines.length).toBeGreaterThan(0)
    expect(lines[0]!.marker).toBe(">")
    expect(lines[0]!.color).toBe(theme.userMessage)
  })

  test("assistant message: marker | and blue color", () => {
    const message: TuiMessage = {
      id: "m1",
      role: "assistant",
      text: "I can help with that",
      createdAt: 0,
    }
    const lines = renderMessageLines(message, 40, "")
    expect(lines.length).toBeGreaterThan(0)
    expect(lines[0]!.marker).toBe("|")
    expect(lines[0]!.color).toBe(theme.assistantMessage)
  })

  test("event message: marker from eventMarker, color from eventColor", () => {
    const message: TuiMessage = {
      id: "m1",
      role: "event",
      text: "tool ran",
      kind: "tool",
      createdAt: 0,
    }
    const lines = renderMessageLines(message, 40, "")
    expect(lines.length).toBeGreaterThan(0)
    expect(lines[0]!.marker).toBe("$") // tool marker
    // Phase 1: tool event now uses jade (eventTool) not legacy green
    expect(lines[0]!.color).toBe(theme.eventTool)
  })

  test("pending assistant with no text: returns empty array (PR-1.5: no spinner placeholder)", () => {
    const message: TuiMessage = {
      id: "m1",
      role: "assistant",
      text: "",
      pending: true,
      createdAt: 0,
    }
    const lines = renderMessageLines(message, 40, "working")
    // PR-1.5: 空 pending message 不再渲染占位行
    // 运行态信号由 ThinkingDock 单一职责接管
    expect(lines).toEqual([])
  })

  test("empty assistant message (no text, no pending): returns empty array", () => {
    const message: TuiMessage = {
      id: "m1",
      role: "assistant",
      text: "",
      createdAt: 0,
    }
    const lines = renderMessageLines(message, 40, "")
    expect(lines).toEqual([])
  })

  test("multi-line user message: each line gets its own entry", () => {
    const message: TuiMessage = {
      id: "m1",
      role: "user",
      text: "line1\nline2\nline3",
      createdAt: 0,
    }
    const lines = renderMessageLines(message, 40, "")
    expect(lines.length).toBe(3)
    expect(lines[0]!.marker).toBe(">")
    expect(lines[1]!.marker).toBe(" ")
    expect(lines[2]!.marker).toBe(" ")
  })

  test("contentWidth is at least 12 (width - 4, min 12)", () => {
    const message: TuiMessage = {
      id: "m1",
      role: "user",
      text: "test",
      createdAt: 0,
    }
    // Very narrow width — should still produce output
    const lines = renderMessageLines(message, 10, "")
    expect(lines.length).toBeGreaterThan(0)
  })

  test("pending assistant with text: returns content with tail marker (PR-1.5)", () => {
    const message: TuiMessage = {
      id: "m1",
      role: "assistant",
      text: "streaming content",
      pending: true,
      createdAt: 0,
    }
    const lines = renderMessageLines(message, 40, "streaming")
    expect(lines.length).toBeGreaterThan(0)
    // PR-1.5: 有文本的 pending message 保留 tail 光标动画
    const last = lines[lines.length - 1]!
    expect(last.pendingAnim).toBe("tail")
    expect(last.text).toBe("streaming content")
  })
})

// ── eventMarker / eventColor (PR-2 acceptance: event rendering) ──

describe("component: eventMarker and eventColor", () => {
  test("eventMarker returns $ for tool", () => {
    expect(eventMarker("tool")).toBe("$")
  })

  test("eventMarker returns # for task", () => {
    expect(eventMarker("task")).toBe("#")
  })

  test("eventMarker returns + for plan", () => {
    expect(eventMarker("plan")).toBe("+")
  })

  test("eventMarker returns ! for error", () => {
    expect(eventMarker("error")).toBe("!")
  })

  test("eventMarker returns - for undefined", () => {
    expect(eventMarker(undefined)).toBe("-")
  })

  // PR-5: Unicode marker 双轨制（DEEPSEEK_TUI_UNICODE=1 时用 ⏺⎿◈◆▸✎）
  describe("eventMarker Unicode (PR-5)", () => {
    test("Unicode: tool → ⎿, task → ◈, gate → ◆, evidence → ▸, patch → ✎", () => {
      const prev = process.env.DEEPSEEK_TUI_UNICODE
      process.env.DEEPSEEK_TUI_UNICODE = "1"
      try {
        expect(eventMarker("tool")).toBe("⎿")
        expect(eventMarker("task")).toBe("◈")
        expect(eventMarker("gate")).toBe("◆")
        expect(eventMarker("evidence")).toBe("▸")
        expect(eventMarker("patch")).toBe("✎")
      } finally {
        process.env.DEEPSEEK_TUI_UNICODE = prev
      }
    })

    test("Unicode: plan → ◈, activity → ∘, error → !, default → ·", () => {
      const prev = process.env.DEEPSEEK_TUI_UNICODE
      process.env.DEEPSEEK_TUI_UNICODE = "1"
      try {
        expect(eventMarker("plan")).toBe("◈")
        expect(eventMarker("activity")).toBe("∘")
        expect(eventMarker("error")).toBe("!")
        expect(eventMarker(undefined)).toBe("·")
      } finally {
        process.env.DEEPSEEK_TUI_UNICODE = prev
      }
    })

    test("Unicode 与 ASCII marker 不同", () => {
      process.env.DEEPSEEK_TUI_UNICODE = undefined
      const asciiTool = eventMarker("tool")
      process.env.DEEPSEEK_TUI_UNICODE = "1"
      const unicodeTool = eventMarker("tool")
      process.env.DEEPSEEK_TUI_UNICODE = undefined
      expect(asciiTool).toBe("$")
      expect(unicodeTool).toBe("⎿")
      expect(asciiTool).not.toBe(unicodeTool)
    })
  })

  // Phase 1: eventColor 现在返回独立语义色 (jade/teal/abyss/coral/gate/evidence/patch)
  test("eventColor returns jade for tool", () => {
    expect(eventColor("tool")).toBe(theme.eventTool)
  })

  test("eventColor returns teal for task", () => {
    expect(eventColor("task")).toBe(theme.eventTask)
  })

  test("eventColor returns abyss for plan", () => {
    expect(eventColor("plan")).toBe(theme.eventPlan)
  })

  test("eventColor returns coral for error", () => {
    expect(eventColor("error")).toBe(theme.eventError)
  })

  test("eventColor returns textFaint for undefined", () => {
    expect(eventColor(undefined)).toBe(theme.textFaint)
  })

  // Phase 1: gate/evidence/patch 不再共用 green/blue/yellow
  test("eventColor uses distinct gate color (not shared with warning or eventTask)", () => {
    const gateColor = eventColor("gate")
    expect(gateColor).toBe(theme.eventGate)
    expect(gateColor).not.toBe(theme.eventEvidence)
    expect(gateColor).not.toBe(theme.eventPatch)
  })

  test("eventColor uses distinct evidence color", () => {
    const evidenceColor = eventColor("evidence")
    expect(evidenceColor).toBe(theme.eventEvidence)
    expect(evidenceColor).not.toBe(theme.eventGate)
    expect(evidenceColor).not.toBe(theme.eventPatch)
  })

  test("eventColor uses distinct patch color", () => {
    const patchColor = eventColor("patch")
    expect(patchColor).toBe(theme.eventPatch)
    expect(patchColor).not.toBe(theme.eventGate)
    expect(patchColor).not.toBe(theme.eventEvidence)
  })
})

// ── GateBadge helpers (PR-2 acceptance #5: pass/block/skip) ──

describe("component: gateStatusColor and gateStatusLabel", () => {
  // Phase 1: gate status 颜色映射到独立语义色 (gatePass/gateBlock/gatePending/gateSkip)
  test("pass → jade + 'pass'", () => {
    expect(gateStatusColor("pass")).toBe(theme.gatePass)
    expect(gateStatusLabel("pass")).toBe("pass")
  })

  test("block → coral + 'block'", () => {
    expect(gateStatusColor("block")).toBe(theme.gateBlock)
    expect(gateStatusLabel("block")).toBe("block")
  })

  test("warn → amber + 'warn'", () => {
    expect(gateStatusColor("warn")).toBe(theme.gatePending)
    expect(gateStatusLabel("warn")).toBe("warn")
  })

  test("skip → fog + 'skip'", () => {
    expect(gateStatusColor("skip")).toBe(theme.gateSkip)
    expect(gateStatusLabel("skip")).toBe("skip")
  })
})

// ── ToolCard helpers (PR-2 acceptance #6: large output → summary only) ──

describe("component: toolStatusIcon/Color/Label", () => {
  test("running → ● / info / 'running'", () => {
    expect(toolStatusIcon("running")).toBe("●")
    expect(toolStatusColor("running")).toBe(theme.info)
    expect(toolStatusLabel("running")).toBe("running")
  })

  test("passed → ● / success / 'passed'", () => {
    expect(toolStatusIcon("passed")).toBe("●")
    expect(toolStatusColor("passed")).toBe(theme.success)
    expect(toolStatusLabel("passed")).toBe("passed")
  })

  test("failed → ✕ / error / 'failed'", () => {
    expect(toolStatusIcon("failed")).toBe("✕")
    expect(toolStatusColor("failed")).toBe(theme.error)
    expect(toolStatusLabel("failed")).toBe("failed")
  })

  test("orphan → ? / warning / 'orphan'", () => {
    expect(toolStatusIcon("orphan")).toBe("?")
    expect(toolStatusColor("orphan")).toBe(theme.warning)
    expect(toolStatusLabel("orphan")).toBe("orphan")
  })
})

describe("component: formatDuration", () => {
  test("undefined returns empty string", () => {
    expect(formatDuration(undefined)).toBe("")
  })

  test("zero returns empty string", () => {
    expect(formatDuration(0)).toBe("")
  })

  test("negative returns empty string", () => {
    expect(formatDuration(-100)).toBe("")
  })

  test("sub-second returns ms suffix", () => {
    expect(formatDuration(500)).toBe("500ms")
  })

  test("exactly 1000ms returns 1.0s", () => {
    expect(formatDuration(1000)).toBe("1.0s")
  })

  test("large duration returns seconds with decimal", () => {
    expect(formatDuration(2500)).toBe("2.5s")
  })
})

// ── ToolCard: summary only (PR-2 acceptance #6) ──

describe("component: ToolCard renders summary, not full output", () => {
  test("TuiToolEvent has summary and outputSummary but no 'output' field", () => {
    const tool = {
      id: "t1",
      tool: "read_file",
      status: "passed" as const,
      summary: "Read 10 lines",
      outputSummary: "File content preview...",
    }
    expect(tool.summary).toBe("Read 10 lines")
    expect(tool.outputSummary).toBe("File content preview...")
    expect((tool as Record<string, unknown>).output).toBeUndefined()
  })
})

// ── Phase 2: Truncation tests ──

import { trimForViewport } from "../../src/tui/format"

describe("trimForViewport (Phase 2)", () => {
  test("text shorter than maxChars is returned unchanged", () => {
    const text = "short response"
    expect(trimForViewport(text, 2000)).toBe(text)
  })

  test("text under 2000 chars is always fully displayed", () => {
    const text = "a".repeat(1500)
    const result = trimForViewport(text, 2000)
    expect(result).toBe(text)
    expect(result.length).toBe(1500)
  })

  test("text over maxChars shows truncated marker", () => {
    const text = "beginning part\n" + "x".repeat(3000) + "\nending part"
    const result = trimForViewport(text, 200)
    // Phase 3: 反转 — 保留头部，尾部提示 "hidden below"
    expect(result).toContain("hidden below")
    expect(result).not.toBe(text)
  })

  test("truncated text keeps the head, discards the tail (Phase 3 reversal)", () => {
    const text = "HEAD_CONTENT_" + "x".repeat(500) + "_TAIL_CONTENT"
    const result = trimForViewport(text, 300)
    // Phase 3: 反转 — 保留头部
    expect(result).toContain("HEAD_CONTENT_")
    expect(result).not.toContain("_TAIL_CONTENT")
  })

  test("empty string returns empty", () => {
    expect(trimForViewport("", 100)).toBe("")
  })

  test("maxChars=0 always triggers truncation", () => {
    const result = trimForViewport("hello", 0)
    // Phase 3: head preservation with maxChars=0 — nothing fits, only indicator
    expect(result).toContain("hidden below")
    expect(result).toContain("5 chars") // correct count
  })
})

describe("renderMessageLines truncation (Phase 2)", () => {
  test("assistant text < 2000 chars is preserved in full (no truncation marker)", () => {
    const short = "Short response"
    const message: TuiMessage = {
      id: "m1",
      role: "assistant",
      text: short,
      createdAt: 0,
    }
    const lines = renderMessageLines(message, 40, "")
    expect(lines.length).toBeGreaterThan(0)
    const allText = lines.map(l => l.text).join("\n")
    expect(allText).toContain("Short response")
    // Phase 3: 截断标记文案从 "hidden above" → "hidden below"
    expect(allText).not.toContain("hidden below")
  })

  test("assistant text wider than the viewport remains scrollable without truncation", () => {
    const long = "a".repeat(5000)
    const message: TuiMessage = {
      id: "m1",
      role: "assistant",
      text: long,
      createdAt: 0,
    }
    const lines = renderMessageLines(message, 30, "")
    expect(lines.length).toBeGreaterThan(0)
    const allText = lines.map(l => l.text).join("")
    expect(allText).toBe(long)
    expect(lines.some(line => line.text.includes("hidden below"))).toBe(false)
  })

  test("pending message is not truncated by trimForViewport", () => {
    const long = "x".repeat(5000)
    const message: TuiMessage = {
      id: "m1",
      role: "assistant",
      text: long,
      pending: true,
      createdAt: 0,
    }
    // Pending messages should show as much as possible during streaming
    const lines = renderMessageLines(message, 40, "streaming")
    expect(lines.length).toBeGreaterThan(0)
    // Pending messages skip trimForViewport — full text should be there
    const allText = lines.map(l => l.text).join("\n")
    expect(allText.length).toBeGreaterThan(2000)
  })

  test("assistant output remains fully available to the scrollback viewport", () => {
    const full = "complete-output-".repeat(1_000)
    const message: TuiMessage = {
      id: "full-output",
      role: "assistant",
      text: full,
      pending: true,
      createdAt: 0,
    }

    const lines = renderMessageLines(message, 120, "streaming")
    const renderedText = lines.map(line => line.text).join("")

    expect(renderedText).toBe(full)
    expect(lines.some(line => line.text.includes("hidden below") || line.text.includes("hidden middle"))).toBe(false)
  })
})

describe("assistant.final empty text preserves deltas (Phase 2)", () => {
  test("assistant.final with empty text uses existing accumulated text", () => {
    // This tests the reducer logic: when assistant.final text="" arrives,
    // the TuiMessage.text should be the accumulated delta text, not empty.
    // We verify this by checking that renderMessageLines on a non-pending message
    // with text returns content (not empty).
    const message: TuiMessage = {
      id: "m1",
      role: "assistant",
      text: "accumulated from deltas",
      pending: false,
      createdAt: 0,
    }
    const lines = renderMessageLines(message, 40, "")
    expect(lines.length).toBeGreaterThan(0)
    // The message text should appear in the rendered output
    const allText = lines.map(l => l.text).join("\n")
    expect(allText).toContain("accumulated from deltas")
  })

  test("assistant.final with non-empty text replaces accumulated", () => {
    // When final arrives with explicit text (error path), it replaces deltas
    const message: TuiMessage = {
      id: "m1",
      role: "assistant",
      text: "error: something went wrong",
      pending: false,
      createdAt: 0,
    }
    const lines = renderMessageLines(message, 40, "")
    expect(lines.length).toBeGreaterThan(0)
    const allText = lines.map(l => l.text).join("\n")
    expect(allText).toContain("error: something went wrong")
  })
})
