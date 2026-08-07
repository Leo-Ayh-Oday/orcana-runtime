/** Rule Capsule — phase-scoped constraint injection for long tasks.
 *
 *  The runtime owns rules. The model may propose actions; the rule capsule
 *  decides what constraints are active and injects them at state transitions.
 *
 *  Design invariants:
 *    - Only active-phase rules are injected — not all rules every time
 *    - Capsule refreshes at state boundaries (PLAN→CODE, CODE→VERIFY)
 *    - Capsule does NOT duplicate full conversation history
 *    - Rules are deterministic (no LLM involvement in capsule generation)
 */

import { AgentState } from "./state-machine"
import type { JournalEngine, Violation } from "./journal"

// ── Phase-scoped rule sets ──

export interface PhaseRules {
  phase: AgentState
  /** Rule IDs active during this phase */
  activeRuleIds: string[]
  /** Phase-specific obligations beyond journal rules */
  obligations: string[]
  /** Hard stops: conditions that block continuing */
  hardStops: string[]
}

const PHASE_RULE_MAP: Record<AgentState, PhaseRules> = {
  [AgentState.IDLE]: {
    phase: AgentState.IDLE,
    activeRuleIds: [],
    obligations: [],
    hardStops: [],
  },
  [AgentState.UNDERSTAND]: {
    phase: AgentState.UNDERSTAND,
    activeRuleIds: [],
    obligations: [
      "Read project structure before making claims",
      "Check existing patterns and conventions",
      "Identify dependencies and constraints",
    ],
    hardStops: [
      "No write tools allowed in UNDERSTAND phase",
    ],
  },
  [AgentState.SEARCH]: {
    phase: AgentState.SEARCH,
    activeRuleIds: [],
    obligations: [
      "Gather complete information before planning",
      "Check for existing implementations before writing new code",
      "Verify API/docs are current (web search when needed)",
    ],
    hardStops: [
      "No write tools in SEARCH phase unless explicitly requested",
    ],
  },
  [AgentState.PLAN]: {
    phase: AgentState.PLAN,
    activeRuleIds: [],
    obligations: [
      "Produce a concrete plan with verification steps",
      "Identify assumptions and risks",
      "Scope plan to the user's actual request — no feature creep",
      "Each plan node must be independently verifiable",
    ],
    hardStops: [
      "No write tools until plan is accepted",
      "No generic checklists — plan must be task-specific",
    ],
  },
  [AgentState.CODE]: {
    phase: AgentState.CODE,
    activeRuleIds: ["no-secret-leak", "no-eval-raw-input", "no-console-in-production", "no-any-type-abuse", "no-unhandled-promise"],
    obligations: [
      "Read target files before editing",
      "Apply atomic changes — use multi_edit for cascade edits",
      "Run ripple check before writes on exported symbols",
      "Keep changes minimal — no unrelated refactoring",
      "Each write must be traceable to a plan node",
    ],
    hardStops: [
      "Blocked if changed files exceed plan scope without justification",
      "Blocked if ripple finds unsynchronized callers",
      "Blocked if journal reports blocking violations",
    ],
  },
  [AgentState.VERIFY]: {
    phase: AgentState.VERIFY,
    activeRuleIds: ["no-secret-leak", "no-console-in-production"],
    obligations: [
      "Run typecheck: bun run typecheck",
      "Run tests: bun test",
      "Verify ripple obligations are resolved",
      "Check generated code against plan checklist",
    ],
    hardStops: [
      "No completion without external verification evidence",
      "No self-certification — tests and typecheck own completion",
    ],
  },
  [AgentState.REPAIR]: {
    phase: AgentState.REPAIR,
    activeRuleIds: [],
    obligations: [
      "Diagnose the specific failure — not guess",
      "Check error messages, logs, and test output",
      "Fix root cause, not symptoms",
      "After fix, re-run verification before declaring done",
    ],
    hardStops: [
      "Max 2 repair attempts per failure before escalating",
      "Do not silently change approach — explain what changed",
    ],
  },
  [AgentState.DONE]: {
    phase: AgentState.DONE,
    activeRuleIds: [],
    obligations: [
      "Provide delivery report with verification evidence",
      "List changed files",
      "Report any residual risks or unfinished items",
      "Suggest next steps if applicable",
    ],
    hardStops: [
      "No claiming completion without evidence",
    ],
  },
  [AgentState.BLOCKED]: {
    phase: AgentState.BLOCKED,
    activeRuleIds: [],
    obligations: [
      "Explain what blocked progress",
      "List what was tried",
      "Suggest what the user can do to unblock",
    ],
    hardStops: [
      "No further tool calls in blocked state",
    ],
  },
  [AgentState.STALLED]: {
    phase: AgentState.STALLED,
    activeRuleIds: [],
    obligations: [
      "Diagnose why no progress occurred across 4 rounds",
      "List what was tried",
    ],
    hardStops: [
      "No further tool calls in stalled state",
    ],
  },
}

// ── Capsule Manager ──

export interface RuleCapsule {
  /** Human-readable constraints for this phase */
  prompt: string
  /** Phase identifier */
  phase: AgentState
  /** Count violations from journal check */
  violations: Violation[]
}

export class RuleCapsuleManager {
  private journal: JournalEngine
  private injectedPhases = new Set<AgentState>()
  private violationHistory: Violation[] = []
  private currentPhase: AgentState = AgentState.IDLE

  constructor(journal: JournalEngine) {
    this.journal = journal
  }

  /** Build a capsule for the current phase. Called every round to prevent rule drift. */
  buildCapsule(phase: AgentState): RuleCapsule {
    const rules = PHASE_RULE_MAP[phase]
    const lines: string[] = []

    lines.push("<system-reminder>")
    lines.push(`## Active Constraints — ${phase.toUpperCase()} Phase`)

    if (rules.obligations.length > 0) {
      lines.push("")
      lines.push("### Obligations")
      for (const o of rules.obligations) {
        lines.push(`- ${o}`)
      }
    }

    if (rules.hardStops.length > 0) {
      lines.push("")
      lines.push("### Hard Stops")
      for (const s of rules.hardStops) {
        lines.push(`- BLOCK: ${s}`)
      }
    }

    // Include active journal rules
    if (rules.activeRuleIds.length > 0) {
      const journalSummary = this.journal.getRulesSummary()
      if (journalSummary) {
        lines.push("")
        lines.push("### Active Journal Rules")
        lines.push(journalSummary)
      }
    }

    // Include recent violation history if applicable
    const recentViolations = this.violationHistory.filter(v => v.severity === "block").slice(-3)
    if (recentViolations.length > 0) {
      lines.push("")
      lines.push("### Recent Violations (Do Not Repeat)")
      for (const v of recentViolations) {
        lines.push(`- [${v.ruleId}] ${v.reason}`)
      }
    }

    lines.push("")
    lines.push("These constraints are enforced by the runtime, not the model.")
    lines.push("The model may propose actions; the runtime decides whether they proceed.")
    lines.push("</system-reminder>")

    this.injectedPhases.add(phase)
    this.currentPhase = phase

    return {
      prompt: lines.join("\n"),
      phase,
      violations: [...this.violationHistory],
    }
  }

  /** Record violations and decide if the current phase should continue. */
  recordViolations(violations: Violation[]): { blocked: boolean; report: string } {
    this.violationHistory.push(...violations)
    const blockingViolations = violations.filter(v => v.severity === "block")
    const warningViolations = violations.filter(v => v.severity === "warn")
    const blocked = blockingViolations.length > 0

    let report = ""
    if (blocked) {
      report = [
        "\n[RUNTIME] 违反铁律 — 当前操作被否决",
        ...blockingViolations.map(v => `  block: [${v.ruleId}] ${v.reason}`),
        "",
        "请修复以上问题后重试。不得绕过铁律。",
      ].join("\n")
    } else if (warningViolations.length > 0) {
      report = warningViolations.map(v => `  warn: [${v.ruleId}] ${v.reason}`).join("\n")
    }

    return { blocked, report }
  }

  /** Reset phase tracking (called when plan is revised or session resumes). */
  resetPhase() {
    this.injectedPhases.clear()
    this.currentPhase = AgentState.IDLE
  }

  /** Get the current active phase. */
  getCurrentPhase(): AgentState {
    return this.currentPhase
  }

  /** Get accumulated violation count for monitoring. */
  violationCount(): number {
    return this.violationHistory.length
  }

  /** Build a compact capsule for checkpoint storage. */
  serializeForCheckpoint(): { phase: AgentState; violationCount: number; injectedPhases: string[] } {
    return {
      phase: this.currentPhase,
      violationCount: this.violationHistory.length,
      injectedPhases: [...this.injectedPhases],
    }
  }
}
