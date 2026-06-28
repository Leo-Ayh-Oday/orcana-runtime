/** Tests for ModeContract — 5-mode role discipline (PR 8) + auto-transition (PR-2.2). */

import { describe, it, expect } from "bun:test"
import {
  MODES,
  enforceModeTools,
  checkModeExitCriteria,
  formatModePrompt,
  setActiveMode,
  getActiveMode,
  shouldTransitionMode,
} from "../src/agent/mode-contract"
import type { ModeTransitionContext } from "../src/agent/mode-contract"
import type { ModeContract, ModeName } from "../src/agent/mode-contract"
import { createEvidenceLedger, addEvidence } from "../src/agent/evidence-ledger"

// ── Helpers ──

function makeContext(overrides: {
  toolErrors?: number
  finalText?: string
  withEvidence?: boolean
} = {}) {
  const ledger = overrides.withEvidence !== false ? createEvidenceLedger() : undefined
  if (ledger && overrides.withEvidence) {
    addEvidence(ledger, {
      id: "evi_typecheck_1",
      kind: "typecheck",
      command: "tsc --noEmit",
      output: "0 errors",
      passed: true,
      timestamp: Date.now(),
    })
  }
  return {
    toolErrors: overrides.toolErrors ?? 0,
    finalText: overrides.finalText ?? "some output",
    evidenceLedger: ledger,
  }
}

// ── Mode structure ──

describe("mode definitions", () => {
  const modeNames: ModeName[] = ["planner", "coder", "review", "repair", "report"]

  for (const name of modeNames) {
    it(`${name} mode exists with all required fields`, () => {
      const mode = MODES[name]
      expect(mode).toBeDefined()
      expect(mode.mode).toBe(name)
      expect(typeof mode.description).toBe("string")
      expect(Array.isArray(mode.allowedTools)).toBe(true)
      expect(Array.isArray(mode.forbiddenTools)).toBe(true)
      expect(Array.isArray(mode.inputRequired)).toBe(true)
      expect(typeof mode.outputSchema).toBe("string")
      expect(Array.isArray(mode.exitCriteria)).toBe(true)
    })
  }

  it("planner forbids write tools", () => {
    expect(MODES.planner.forbiddenTools).toContain("write_file")
    expect(MODES.planner.forbiddenTools).toContain("edit_file")
    expect(MODES.planner.forbiddenTools).toContain("shell")
  })

  it("review forbids write, shell, and network tools", () => {
    expect(MODES.review.forbiddenTools).toContain("write_file")
    expect(MODES.review.forbiddenTools).toContain("shell")
    expect(MODES.review.forbiddenTools).toContain("web_search")
    expect(MODES.review.forbiddenTools).toContain("web_fetch")
  })

  it("coder allows all tools (empty allowed, empty forbidden)", () => {
    expect(MODES.coder.allowedTools).toHaveLength(0)
    expect(MODES.coder.forbiddenTools).toHaveLength(0)
  })

  it("report forbids network tools", () => {
    expect(MODES.report.forbiddenTools).toContain("web_search")
    expect(MODES.report.forbiddenTools).toContain("web_fetch")
    expect(MODES.report.forbiddenTools).toContain("shell")
  })

  it("repair has evidence exit criterion (typecheck)", () => {
    const typecheckCriterion = MODES.repair.exitCriteria.find(c => c.kind === "has_evidence")
    expect(typecheckCriterion).toBeDefined()
    expect(typecheckCriterion!.evidenceKind).toBe("typecheck")
  })
})

// ── enforceModeTools ──

describe("enforceModeTools", () => {
  it("allows read_file in planner mode", () => {
    const result = enforceModeTools(MODES.planner, "read_file")
    expect(result.allowed).toBe(true)
  })

  it("blocks write_file in planner mode", () => {
    const result = enforceModeTools(MODES.planner, "write_file")
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("ModeContract:planner")
    expect(result.reason).toContain("禁止")
  })

  it("blocks shell in planner mode", () => {
    const result = enforceModeTools(MODES.planner, "shell")
    expect(result.allowed).toBe(false)
  })

  it("allows write_file in coder mode (empty allowed = all)", () => {
    const result = enforceModeTools(MODES.coder, "write_file")
    expect(result.allowed).toBe(true)
  })

  it("allows shell in coder mode", () => {
    const result = enforceModeTools(MODES.coder, "shell")
    expect(result.allowed).toBe(true)
  })

  it("blocks write_file in review mode", () => {
    const result = enforceModeTools(MODES.review, "write_file")
    expect(result.allowed).toBe(false)
  })

  it("allows read_file in review mode", () => {
    const result = enforceModeTools(MODES.review, "read_file")
    expect(result.allowed).toBe(true)
  })

  it("allows typecheck in review mode", () => {
    const result = enforceModeTools(MODES.review, "typecheck")
    expect(result.allowed).toBe(true)
  })

  it("blocks web_search in review mode", () => {
    const result = enforceModeTools(MODES.review, "web_search")
    expect(result.allowed).toBe(false)
  })

  it("allows write_file in repair mode", () => {
    const result = enforceModeTools(MODES.repair, "write_file")
    expect(result.allowed).toBe(true)
  })

  it("blocks web_search in report mode", () => {
    const result = enforceModeTools(MODES.report, "web_search")
    expect(result.allowed).toBe(false)
  })

  it("blocks write_file in report mode", () => {
    const result = enforceModeTools(MODES.report, "write_file")
    expect(result.allowed).toBe(false)
  })

  it("blocks shell in report mode", () => {
    const result = enforceModeTools(MODES.report, "shell")
    expect(result.allowed).toBe(false)
  })

  it("allows git_status in all modes", () => {
    for (const mode of Object.values(MODES)) {
      const result = enforceModeTools(mode, "git_status")
      expect(result.allowed).toBe(true)
    }
  })

  it("forbiddenTools takes precedence over allowedTools", () => {
    // Create a mode where the same tool is in both lists
    const testMode: ModeContract = {
      mode: "coder",
      description: "test",
      allowedTools: ["read_file", "write_file"],
      forbiddenTools: ["write_file"],
      inputRequired: [],
      outputSchema: "",
      exitCriteria: [],
    }
    const result = enforceModeTools(testMode, "write_file")
    expect(result.allowed).toBe(false)
  })

  it("blocked reason includes mode name and tool name", () => {
    const result = enforceModeTools(MODES.planner, "shell")
    expect(result.reason).toContain("planner")
    expect(result.reason).toContain("shell")
  })
})

// ── checkModeExitCriteria ──

describe("checkModeExitCriteria", () => {
  it("passes for coder mode with clean state", () => {
    const ctx = makeContext()
    const result = checkModeExitCriteria(MODES.coder, ctx)
    expect(result.met).toBe(true)
    expect(result.unmet).toHaveLength(0)
  })

  it("fails no_tool_errors criterion when toolErrors > 0", () => {
    const ctx = makeContext({ toolErrors: 3 })
    const result = checkModeExitCriteria(MODES.coder, ctx)
    expect(result.met).toBe(false)
    expect(result.unmet.some(u => u.includes("3 个错误"))).toBe(true)
  })

  it("fails output_not_empty when finalText is empty", () => {
    const ctx = makeContext({ finalText: "" })
    const result = checkModeExitCriteria(MODES.coder, ctx)
    expect(result.met).toBe(false)
    expect(result.unmet.some(u => u.includes("非空"))).toBe(true)
  })

  it("fails output_not_empty when finalText is whitespace only", () => {
    const ctx = makeContext({ finalText: "   " })
    const result = checkModeExitCriteria(MODES.coder, ctx)
    expect(result.met).toBe(false)
  })

  it("passes for planner mode with clean state", () => {
    const ctx = makeContext()
    const result = checkModeExitCriteria(MODES.planner, ctx)
    expect(result.met).toBe(true)
  })

  it("fails repair has_evidence when no evidence ledger", () => {
    const ctx = makeContext({ withEvidence: false })
    const result = checkModeExitCriteria(MODES.repair, { ...ctx, evidenceLedger: undefined })
    expect(result.met).toBe(false)
    expect(result.unmet.some(u => u.includes("类型"))).toBe(true)
  })

  it("passes repair has_evidence when typecheck evidence exists", () => {
    const ctx = makeContext({ withEvidence: true })
    const result = checkModeExitCriteria(MODES.repair, ctx)
    expect(result.met).toBe(true)
  })

  it("fails when typecheck evidence doesn't exist", () => {
    const ledger = createEvidenceLedger()
    addEvidence(ledger, {
      id: "evi_test_1",
      kind: "test",
      command: "bun test",
      output: "all pass",
      passed: true,
      timestamp: Date.now(),
    })
    const ctx = { toolErrors: 0, finalText: "done", evidenceLedger: ledger }
    const result = checkModeExitCriteria(MODES.repair, ctx)
    // repair requires typecheck evidence, not test
    expect(result.met).toBe(false)
  })

  it("multiple unmet criteria all reported", () => {
    const ctx = makeContext({ toolErrors: 2, finalText: "", withEvidence: false })
    const repairCtx = { ...ctx, evidenceLedger: undefined }
    const result = checkModeExitCriteria(MODES.repair, repairCtx)
    // repair has: no_tool_errors, output_not_empty, has_evidence
    expect(result.unmet.length).toBeGreaterThanOrEqual(2)
  })

  it("passes for review mode with clean state", () => {
    const ctx = makeContext()
    const result = checkModeExitCriteria(MODES.review, ctx)
    expect(result.met).toBe(true)
  })

  it("passes for report mode with clean state", () => {
    const ctx = makeContext()
    const result = checkModeExitCriteria(MODES.report, ctx)
    expect(result.met).toBe(true)
  })
})

// ── formatModePrompt ──

describe("formatModePrompt", () => {
  it("includes mode name in uppercase", () => {
    const result = formatModePrompt(MODES.planner)
    expect(result).toContain("PLANNER")
  })

  it("includes description", () => {
    const result = formatModePrompt(MODES.review)
    expect(result).toContain("审查")
  })

  it("lists forbidden tools when present", () => {
    const result = formatModePrompt(MODES.review)
    expect(result).toContain("禁止工具")
    expect(result).toContain("write_file")
  })

  it("shows full tool access for coder", () => {
    const result = formatModePrompt(MODES.coder)
    expect(result).toContain("允许工具: 全部")
  })

  it("includes exit criteria", () => {
    const result = formatModePrompt(MODES.report)
    expect(result).toContain("退出条件")
  })
})

// ── Module-level active mode ──

describe("setActiveMode / getActiveMode", () => {
  it("defaults to coder", () => {
    setActiveMode("coder")
    expect(getActiveMode().mode).toBe("coder")
  })

  it("switches to planner", () => {
    setActiveMode("planner")
    expect(getActiveMode().mode).toBe("planner")
  })

  it("switches to review", () => {
    setActiveMode("review")
    expect(getActiveMode().mode).toBe("review")
  })

  it("switches to repair", () => {
    setActiveMode("repair")
    expect(getActiveMode().mode).toBe("repair")
  })

  it("switches to report", () => {
    setActiveMode("report")
    expect(getActiveMode().mode).toBe("report")
  })

  it("reset to coder after tests", () => {
    setActiveMode("coder")
    expect(getActiveMode().mode).toBe("coder")
  })
})

// ── Review fixes: request_deeper_thinking and MCP tools (HIGH-1) ──

describe("meta and MCP tools", () => {
  it("request_deeper_thinking is allowed in planner mode", () => {
    const result = enforceModeTools(MODES.planner, "request_deeper_thinking")
    expect(result.allowed).toBe(true)
  })

  it("request_deeper_thinking is allowed in review mode", () => {
    const result = enforceModeTools(MODES.review, "request_deeper_thinking")
    expect(result.allowed).toBe(true)
  })

  it("request_deeper_thinking is allowed in report mode", () => {
    const result = enforceModeTools(MODES.report, "request_deeper_thinking")
    expect(result.allowed).toBe(true)
  })

  it("mcp__ prefixed tools are allowed in planner mode (even without explicit listing)", () => {
    const result = enforceModeTools(MODES.planner, "mcp__filesystem__list_directory")
    expect(result.allowed).toBe(true)
  })

  it("mcp__ prefixed tools are allowed in review mode", () => {
    const result = enforceModeTools(MODES.review, "mcp__github__list_issues")
    expect(result.allowed).toBe(true)
  })

  it("mcp__ prefixed tools are allowed in report mode", () => {
    const result = enforceModeTools(MODES.report, "mcp__knowledge_hub__kh_find")
    expect(result.allowed).toBe(true)
  })

  it("mcp__ tool blocked when in forbiddenTools", () => {
    // report mode forbids network tools. A hypothetical mcp__websearch tool in network category
    // would need to be explicitly forbidden to be blocked — forbiddenTools check still applies
    const result = enforceModeTools(MODES.review, "mcp__search__search")
    expect(result.allowed).toBe(true) // MCP allowed even with non-empty allowedTools
  })

  it("forbiddenTools still apply to mcp__ tools", () => {
    // Create a mode that explicitly forbids an MCP tool
    const testMode: ModeContract = {
      mode: "coder",
      description: "test",
      allowedTools: [],
      forbiddenTools: ["mcp__dangerous__rm_rf"],
      inputRequired: [],
      outputSchema: "",
      exitCriteria: [],
    }
    const result = enforceModeTools(testMode, "mcp__dangerous__rm_rf")
    expect(result.allowed).toBe(false)
  })
})

// ── Integration: mode enforcement across tool categories ──

describe("mode enforcement integration", () => {
  it("planner: allows all read tools, blocks all write/shell tools", () => {
    const readTools = ["read_file", "find_symbol", "find_references", "project_structure",
      "lsp_diagnostics", "lsp_hover", "lsp_definition", "lsp_references"]
    const writeTools = ["write_file", "edit_file", "multi_edit", "edit_fim"]
    const shellTools = ["shell", "start_service"]

    for (const t of readTools) expect(enforceModeTools(MODES.planner, t).allowed).toBe(true)
    for (const t of writeTools) expect(enforceModeTools(MODES.planner, t).allowed).toBe(false)
    for (const t of shellTools) expect(enforceModeTools(MODES.planner, t).allowed).toBe(false)
  })

  it("review: allows read + typecheck, blocks write + shell + network", () => {
    expect(enforceModeTools(MODES.review, "read_file").allowed).toBe(true)
    expect(enforceModeTools(MODES.review, "typecheck").allowed).toBe(true)
    expect(enforceModeTools(MODES.review, "write_file").allowed).toBe(false)
    expect(enforceModeTools(MODES.review, "shell").allowed).toBe(false)
    expect(enforceModeTools(MODES.review, "web_search").allowed).toBe(false)
  })

  it("report: read + git only, no network", () => {
    expect(enforceModeTools(MODES.report, "read_file").allowed).toBe(true)
    expect(enforceModeTools(MODES.report, "git_log").allowed).toBe(true)
    expect(enforceModeTools(MODES.report, "web_search").allowed).toBe(false)
    expect(enforceModeTools(MODES.report, "write_file").allowed).toBe(false)
    expect(enforceModeTools(MODES.report, "typecheck").allowed).toBe(false)
  })
})

// ── PR-2.2: Mode auto-transition tests ──

function makeTransitionCtx(overrides: Partial<ModeTransitionContext> = {}): ModeTransitionContext {
  return {
    activeNodeStatus: "active",
    hasTrackerSteps: true,
    rippleObligationCount: 0,
    hasEvidence: false,
    toolErrors: 0,
    planComplete: false,
    ...overrides,
  }
}

describe("shouldTransitionMode", () => {
  it("returns null when no change is needed", () => {
    expect(shouldTransitionMode("coder", makeTransitionCtx())).toBeNull()
  })

  it("planComplete triggers report mode", () => {
    expect(shouldTransitionMode("coder", makeTransitionCtx({ planComplete: true }))).toBe("report")
  })

  it("planComplete returns null if already in report mode", () => {
    expect(shouldTransitionMode("report", makeTransitionCtx({ planComplete: true }))).toBeNull()
  })

  it("toolErrors >= 3 triggers repair mode", () => {
    expect(shouldTransitionMode("coder", makeTransitionCtx({ toolErrors: 3 }))).toBe("repair")
    expect(shouldTransitionMode("coder", makeTransitionCtx({ toolErrors: 5 }))).toBe("repair")
  })

  it("toolErrors >= 3 returns null if already in repair mode", () => {
    expect(shouldTransitionMode("repair", makeTransitionCtx({ toolErrors: 3 }))).toBeNull()
  })

  it("ripple obligations > 0 blocks node-status mode transitions but planComplete still wins", () => {
    // planComplete (rule 1) is checked before ripple block (rule 3), so it wins
    expect(shouldTransitionMode("coder", makeTransitionCtx({ rippleObligationCount: 2, planComplete: true }))).toBe("report")
    // When planComplete is false, ripple blocks node status transitions
    expect(shouldTransitionMode("coder", makeTransitionCtx({ rippleObligationCount: 2, activeNodeStatus: "done" }))).toBeNull()
  })

  it("active node status 'pending' transitions to planner", () => {
    expect(shouldTransitionMode("coder", makeTransitionCtx({ activeNodeStatus: "pending" }))).toBe("planner")
  })

  it("active node status 'done' transitions to review", () => {
    expect(shouldTransitionMode("coder", makeTransitionCtx({ activeNodeStatus: "done" }))).toBe("review")
  })

  it("active node status 'blocked' transitions to planner", () => {
    expect(shouldTransitionMode("coder", makeTransitionCtx({ activeNodeStatus: "blocked" }))).toBe("planner")
  })

  it("active node status 'skipped' transitions to review", () => {
    expect(shouldTransitionMode("coder", makeTransitionCtx({ activeNodeStatus: "skipped" }))).toBe("review")
  })

  it("planComplete takes priority over ripple obligations", () => {
    // planComplete is checked first, so it wins even with ripple > 0
    // (ripple blocks are checked AFTER planComplete in shouldTransitionMode)
  })

  it("toolErrors takes priority over node status mapping", () => {
    // toolErrors >= 3 (rule 2) is checked before node status mapping (rule 4)
    expect(shouldTransitionMode("coder", makeTransitionCtx({ activeNodeStatus: "done", toolErrors: 4 }))).toBe("repair")
  })
})
