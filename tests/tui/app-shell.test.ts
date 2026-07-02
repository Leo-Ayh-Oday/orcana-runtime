/** Tests for AppShell — covers PR-2 acceptance points.
 *
 *  Points covered:
 *    1. SLASH_COMMANDS integrity (all commands present, well-formed)
 *    2. computeAppShellLayout: RightRail 在宽屏显示、窄屏隐藏
 *    3. computeAppShellLayout: bodyHeight / footerHeight constraints
 *    4. computeAppShellLayout: clarification panel affects layout
 *    5. computeAppShellLayout: task planning/building affects layout
 *    6. computeAppShellLayout: inputChrome affects footer height
 */

import { describe, expect, test } from "bun:test"
import { SLASH_COMMANDS, computeAppShellLayout } from "../../src/tui/components/AppShell"
import type { InputChromeState, ClarificationWizardState } from "../../src/tui/components/AppShell"
import type { TaskProgressState } from "../../src/tui/components/PlanPanel"
import type { ClarificationQuestion } from "../../src/agent/clarification"

// ── Helpers ──

const defaultInputChrome: InputChromeState = { commandOpen: false, pasteCount: 0, textRows: 1 }

function buildClarification(optionCount = 3): ClarificationWizardState {
  const options = Array.from({ length: optionCount }, (_, i) => ({
    key: String.fromCharCode(65 + i),
    label: `Option ${i + 1}`,
    recommended: i === 0,
  }))
  const question: ClarificationQuestion = {
    id: "q1",
    title: "Which approach?",
    options,
  }
  return {
    originalPrompt: "test prompt",
    questions: [question],
    index: 0,
    selected: 0,
    answers: [],
    rawText: "test",
  }
}

function buildTask(phase: "planning" | "building" | "complete", stepCount = 3): TaskProgressState {
  return {
    goal: "test goal",
    phase,
    done: phase === "complete" ? stepCount : 1,
    total: stepCount,
    current: "step 1",
    steps: Array.from({ length: stepCount }, (_, i) => ({
      id: `s${i}`,
      title: `Step ${i + 1}`,
      status: i === 0 && phase === "building" ? "running" as const : i < 1 ? "done" as const : "pending" as const,
    })),
  }
}

// ── SLASH_COMMANDS ──

describe("AppShell: SLASH_COMMANDS integrity", () => {
  test("contains all expected commands", () => {
    const names = SLASH_COMMANDS.map(cmd => cmd.name)
    expect(names).toContain("help")
    expect(names).toContain("clear")
    expect(names).toContain("save")
    expect(names).toContain("compact")
    expect(names).toContain("sessions")
    expect(names).toContain("search")
    expect(names).toContain("undo")
    expect(names).toContain("stats")
    expect(names).toContain("effort")
    expect(names).toContain("connect")
    expect(names).toContain("models")
    expect(names).toContain("exit")
  })

  test("every command has name and description", () => {
    for (const cmd of SLASH_COMMANDS) {
      expect(cmd.name).toBeTruthy()
      expect(cmd.description).toBeTruthy()
    }
  })

  test("commands with usage have non-empty usage string", () => {
    for (const cmd of SLASH_COMMANDS) {
      if (cmd.usage !== undefined) {
        expect(cmd.usage.length).toBeGreaterThan(0)
      }
    }
  })
})

// ── computeAppShellLayout: RightRail visibility ──

describe("AppShell layout: RightRail visibility (PR-2 acceptance #2)", () => {
  test("RightRail visible on wide screen (>=110 cols) when hasDash=true", () => {
    const layout = computeAppShellLayout({
      rows: 40,
      cols: 120,
      hasDash: true,
      isWorking: false,
      clarification: null,
      task: undefined,
      inputChrome: defaultInputChrome,
    })
    expect(layout.showDash).toBe(true)
  })

  test("RightRail hidden on narrow screen (<110 cols) even when hasDash=true", () => {
    const layout = computeAppShellLayout({
      rows: 40,
      cols: 100,
      hasDash: true,
      isWorking: false,
      clarification: null,
      task: undefined,
      inputChrome: defaultInputChrome,
    })
    expect(layout.showDash).toBe(false)
  })

  test("RightRail hidden on wide screen when hasDash=false", () => {
    const layout = computeAppShellLayout({
      rows: 40,
      cols: 120,
      hasDash: false,
      isWorking: false,
      clarification: null,
      task: undefined,
      inputChrome: defaultInputChrome,
    })
    expect(layout.showDash).toBe(false)
  })

  test("RightRail hidden at exactly 109 cols", () => {
    const layout = computeAppShellLayout({
      rows: 40,
      cols: 109,
      hasDash: true,
      isWorking: false,
      clarification: null,
      task: undefined,
      inputChrome: defaultInputChrome,
    })
    expect(layout.showDash).toBe(false)
  })

  test("RightRail visible at exactly 110 cols", () => {
    const layout = computeAppShellLayout({
      rows: 40,
      cols: 110,
      hasDash: true,
      isWorking: false,
      clarification: null,
      task: undefined,
      inputChrome: defaultInputChrome,
    })
    expect(layout.showDash).toBe(true)
  })
})

// ── computeAppShellLayout: bodyHeight / footerHeight ──

describe("AppShell layout: bodyHeight and footerHeight constraints", () => {
  test("bodyHeight has minimum of 10", () => {
    const layout = computeAppShellLayout({
      rows: 15, // very small terminal
      cols: 80,
      hasDash: false,
      isWorking: false,
      clarification: null,
      task: undefined,
      inputChrome: defaultInputChrome,
    })
    expect(layout.bodyHeight).toBeGreaterThanOrEqual(10)
  })

  test("footerHeight has minimum of 1", () => {
    const layout = computeAppShellLayout({
      rows: 10,
      cols: 80,
      hasDash: false,
      isWorking: false,
      clarification: null,
      task: undefined,
      inputChrome: defaultInputChrome,
    })
    expect(layout.footerHeight).toBeGreaterThanOrEqual(1)
  })

  test("footerHeight = panelRows + inputRows + 1(FooterHints) in normal case", () => {
    const layout = computeAppShellLayout({
      rows: 40,
      cols: 80,
      hasDash: false,
      isWorking: false,
      clarification: null,
      task: undefined,
      inputChrome: defaultInputChrome,
    })
    // No panel, no task → panelRows=0, textRows=1 → inputRows=1+1=2 → footerHeight=0+2+1=3
    expect(layout.panelRows).toBe(0)
    expect(layout.inputRows).toBe(2)
    expect(layout.footerHeight).toBe(3)
  })

  test("bodyHeight + footerHeight + 3 ≈ rows (normal case)", () => {
    const rows = 40
    const layout = computeAppShellLayout({
      rows,
      cols: 80,
      hasDash: false,
      isWorking: false,
      clarification: null,
      task: undefined,
      inputChrome: defaultInputChrome,
    })
    expect(layout.bodyHeight + layout.footerHeight + 3).toBe(rows)
  })
})

// ── computeAppShellLayout: clarification affects layout ──

describe("AppShell layout: clarification panel", () => {
  test("clarification increases panelRows", () => {
    const clarification = buildClarification(4)
    const layout = computeAppShellLayout({
      rows: 40,
      cols: 80,
      hasDash: false,
      isWorking: false,
      clarification,
      task: undefined,
      inputChrome: defaultInputChrome,
    })
    // 4 options → clarificationRows = min(10, 4+4) = 8
    expect(layout.clarificationRows).toBe(8)
    expect(layout.panelRows).toBe(8)
  })

  test("clarification capped at 10 rows", () => {
    const clarification = buildClarification(20)
    const layout = computeAppShellLayout({
      rows: 40,
      cols: 80,
      hasDash: false,
      isWorking: false,
      clarification,
      task: undefined,
      inputChrome: defaultInputChrome,
    })
    expect(layout.clarificationRows).toBe(10)
  })

  test("no clarification → clarificationRows = 0", () => {
    const layout = computeAppShellLayout({
      rows: 40,
      cols: 80,
      hasDash: false,
      isWorking: false,
      clarification: null,
      task: undefined,
      inputChrome: defaultInputChrome,
    })
    expect(layout.clarificationRows).toBe(0)
  })
})

// ── computeAppShellLayout: task affects layout ──

describe("AppShell layout: task panel", () => {
  test("planning task → taskRows = 3", () => {
    const task = buildTask("planning")
    const layout = computeAppShellLayout({
      rows: 40,
      cols: 80,
      hasDash: false,
      isWorking: false,
      clarification: null,
      task,
      inputChrome: defaultInputChrome,
    })
    expect(layout.taskRows).toBe(3)
  })

  test("building task with 3 steps → taskRows = min(5, 1+3) = 4", () => {
    const task = buildTask("building", 3)
    const layout = computeAppShellLayout({
      rows: 40,
      cols: 80,
      hasDash: false,
      isWorking: false,
      clarification: null,
      task,
      inputChrome: defaultInputChrome,
    })
    expect(layout.taskRows).toBe(4)
  })

  test("no task → taskRows = 0", () => {
    const layout = computeAppShellLayout({
      rows: 40,
      cols: 80,
      hasDash: false,
      isWorking: false,
      clarification: null,
      task: undefined,
      inputChrome: defaultInputChrome,
    })
    expect(layout.taskRows).toBe(0)
  })
})

// ── computeAppShellLayout: inputChrome affects footer ──

describe("AppShell layout: inputChrome affects footer height", () => {
  test("commandOpen → inputRows = 5", () => {
    const layout = computeAppShellLayout({
      rows: 40,
      cols: 80,
      hasDash: false,
      isWorking: false,
      clarification: null,
      task: undefined,
      inputChrome: { commandOpen: true, pasteCount: 0, textRows: 1 },
    })
    expect(layout.inputRows).toBe(5)
  })

  test("isWorking with no command → inputRows = 2", () => {
    const layout = computeAppShellLayout({
      rows: 40,
      cols: 80,
      hasDash: false,
      isWorking: true,
      clarification: null,
      task: undefined,
      inputChrome: defaultInputChrome,
    })
    expect(layout.inputRows).toBe(2)
  })

  test("pasteCount > 0 → inputRows = textRows + 1 + 1(paste indicator)", () => {
    const layout = computeAppShellLayout({
      rows: 40,
      cols: 80,
      hasDash: false,
      isWorking: false,
      clarification: null,
      task: undefined,
      inputChrome: { commandOpen: false, pasteCount: 3, textRows: 1 },
    })
    // textRows=1 + status=1 + paste indicator=1 = 3
    expect(layout.inputRows).toBe(3)
  })

  test("textRows=3 (multi-line) → inputRows = 3+1 = 4", () => {
    const layout = computeAppShellLayout({
      rows: 40,
      cols: 80,
      hasDash: false,
      isWorking: false,
      clarification: null,
      task: undefined,
      inputChrome: { commandOpen: false, pasteCount: 0, textRows: 3 },
    })
    expect(layout.inputRows).toBe(4)
  })

  test("idle, no paste, no command → inputRows = textRows + 1 = 2", () => {
    const layout = computeAppShellLayout({
      rows: 40,
      cols: 80,
      hasDash: false,
      isWorking: false,
      clarification: null,
      task: undefined,
      inputChrome: defaultInputChrome,
    })
    expect(layout.inputRows).toBe(2)
  })
})
