import { describe, expect, test } from "bun:test"
import { evaluateCompletionGate, formatCompletionEvidenceReport, formatCompletionGatePrompt } from "../src/agent/external-completion-gate"
import { createTaskTracker, markPlanAccepted, updateTaskTrackerAfterTools } from "../src/agent/task-tracker"

describe("External Completion Gate", () => {
  test("blocks final completion when required evidence is missing", () => {
    const tracker = createTaskTracker("Build a complete full-stack personal blog with React and API", "long_task")!
    markPlanAccepted(tracker)
    updateTaskTrackerAfterTools({
      tracker,
      changedFiles: ["client/src/App.tsx", "client/src/App.css", "server/index.ts", "server/index.test.ts"],
      toolNames: ["write_file"],
      typecheckPassed: true,
    })

    const report = evaluateCompletionGate({
      finalText: "Done",
      taskTracker: tracker,
      missingTaskRequirements: [],
      pendingRippleObligations: [],
      verificationResults: [],
      changedFiles: ["client/src/App.tsx"],
      taskHadWrite: true,
      toolErrors: 0,
      lastTypecheck: { passed: true, issues: 0 },
    })

    expect(report.allowed).toBe(false)
    expect(report.missing.some(item => item.includes("test"))).toBe(true)
    expect(report.missing.some(item => item.includes("build"))).toBe(true)
    expect(formatCompletionGatePrompt(report)).toContain("External Completion Gate")
  })

  test("formats an evidence report when all required signals are present", () => {
    const tracker = createTaskTracker("Build a complete full-stack personal blog with React and API", "long_task")!
    markPlanAccepted(tracker)
    updateTaskTrackerAfterTools({
      tracker,
      changedFiles: ["client/src/App.tsx", "client/src/App.css", "server/index.ts", "server/index.test.ts"],
      toolNames: ["write_file"],
      typecheckPassed: true,
    })
    updateTaskTrackerAfterTools({
      tracker,
      changedFiles: [],
      toolNames: ["shell"],
      verificationResults: [
        { kind: "test", command: "bun test", passed: true, issues: 0, durationMs: 1, summary: "ok" },
        { kind: "build", command: "bunx vite build", passed: true, issues: 0, durationMs: 1, summary: "ok" },
      ],
    })

    const verificationResults = [
      { kind: "test" as const, command: "bun test", passed: true, issues: 0, durationMs: 1, summary: "ok" },
      { kind: "build" as const, command: "bunx vite build", passed: true, issues: 0, durationMs: 1, summary: "ok" },
    ]
    const report = evaluateCompletionGate({
      finalText: "Completed the blog.",
      taskTracker: tracker,
      missingTaskRequirements: [],
      pendingRippleObligations: [],
      verificationResults,
      changedFiles: ["client/src/App.tsx", "server/index.ts"],
      taskHadWrite: true,
      toolErrors: 0,
      lastTypecheck: { passed: true, issues: 0 },
    })

    expect(report.allowed).toBe(true)
    const text = formatCompletionEvidenceReport("Completed the blog.", report)
    expect(text).toContain("Delivery Report")
    expect(text).toContain("## Evidence")
    expect(text).toContain("bun test")
    expect(text).toContain("bunx vite build")
  })

  test("compacts long model final text in evidence report", () => {
    const report = {
      allowed: true,
      missing: [],
      evidenceLines: ["test: passed (bun test)"],
      changedFiles: [],
      residualRisks: [],
    }
    const text = formatCompletionEvidenceReport("detail ".repeat(300), report)

    expect(text.length).toBeLessThan(1000)
    expect(text).toContain("...")
  })
})
