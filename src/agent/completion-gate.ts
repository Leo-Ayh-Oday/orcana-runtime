import { getBlockingObligations, type RippleObligation } from "../ripple/obligations"
import type { VerificationResult } from "../verification/result"
import type { TaskTracker } from "./task-tracker"
import type { UILanguage } from "./language"
import type { EvidenceLedger } from "./evidence-ledger"
import { checkModeExitCriteria, getActiveMode } from "./mode-contract"

export interface CompletionGateInput {
  finalText: string
  taskTracker: TaskTracker | null
  missingTaskRequirements: string[]
  pendingRippleObligations: RippleObligation[]
  verificationResults: VerificationResult[]
  changedFiles: string[]
  taskHadWrite: boolean
  toolErrors: number
  lastTypecheck?: { passed: boolean; issues: number; output?: string }
  /** PR 6: optional evidence ledger for structured evidence check. */
  evidenceLedger?: EvidenceLedger
}

export interface CompletionGateReport {
  allowed: boolean
  missing: string[]
  evidenceLines: string[]
  changedFiles: string[]
  residualRisks: string[]
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))]
}

function formatVerification(result: VerificationResult): string {
  const state = result.passed ? "passed" : "failed"
  const issues = result.issues > 0 ? `, issues=${result.issues}` : ""
  return `${result.kind}: ${state} (${result.command}${issues})`
}

function compactFinalText(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return "Implementation work completed."
  const lines = trimmed
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^#{1,4}\s+/.test(line))
    .filter(line => !/^(External Completion Evidence|Changed Files|Residual Risk)/i.test(line))
  const selected = lines.slice(0, 4).join("\n")
  return selected.length > 700 ? `${selected.slice(0, 700)}...` : selected
}

export function needsExternalCompletionGate(input: Pick<CompletionGateInput, "taskTracker" | "taskHadWrite" | "toolErrors">): boolean {
  // PR 8: always evaluate when mode contract is active — modes have exit criteria
  // that must be checked even without writes/tracker/errors (e.g. planner output_not_empty)
  const activeMode = getActiveMode()
  const hasModeExitCriteria = activeMode.exitCriteria.length > 0
  return Boolean(input.taskTracker || input.taskHadWrite || input.toolErrors > 0 || hasModeExitCriteria)
}

export function evaluateCompletionGate(input: CompletionGateInput): CompletionGateReport {
  const missing: string[] = []
  const residualRisks: string[] = []
  const evidenceLines = input.verificationResults.map(formatVerification)

  if (input.missingTaskRequirements.length > 0) {
    missing.push(...input.missingTaskRequirements)
  }
  // PR 7: only non-waived ripple obligations block completion
  const blockingRipple = getBlockingObligations(input.pendingRippleObligations)
  if (blockingRipple.length > 0) {
    missing.push(`未解决的涟漪义务: ${blockingRipple.length} 个调用方未同步 (需级联修复或显式豁免)`)
  }
  if (input.lastTypecheck && !input.lastTypecheck.passed) {
    missing.push(`typecheck failed: ${input.lastTypecheck.issues} issue(s)`)
  }
  if (input.toolErrors > 0) {
    residualRisks.push(`tool errors occurred during this task: ${input.toolErrors}`)
  }
  if (input.taskHadWrite && input.verificationResults.length === 0 && !input.lastTypecheck?.passed) {
    missing.push("no external verification evidence after writes")
  }
  if (input.taskTracker) {
    for (const kind of input.taskTracker.requiredVerificationKinds) {
      if (!input.taskTracker.verificationEvidence[kind]) missing.push(`missing required verification: ${kind}`)
    }
  }
  // PR-3.2: Evidence check removed — canClaimDone() is the single evidence entry point.
  // Evidence is now exclusively validated by CompletionOrchestrator.evaluateEvidenceGate()
  // which calls canClaimDone() as the final hard gate before "done".
  // PR 8: ModeContract exit criteria check
  const activeMode = getActiveMode()
  const modeExitResult = checkModeExitCriteria(activeMode, {
    toolErrors: input.toolErrors,
    finalText: input.finalText,
    evidenceLedger: input.evidenceLedger,
  })
  if (!modeExitResult.met) {
    for (const unmet of modeExitResult.unmet) {
      missing.push(`[ModeContract:${activeMode.mode}] ${unmet}`)
    }
  }
  // PR 8: skip generic empty-text check when mode contract already reports it
  if (!input.finalText.trim() && modeExitResult.met) {
    residualRisks.push("model final text was empty")
  }

  return {
    allowed: missing.length === 0,
    missing: unique(missing),
    evidenceLines: unique(evidenceLines),
    changedFiles: unique(input.changedFiles).sort(),
    residualRisks: unique(residualRisks),
  }
}

export function formatCompletionGatePrompt(report: CompletionGateReport, language?: UILanguage): string {
  if (language === "zh") {
    return [
      "## 完成门",
      "你现在不能给出最终完成答复。外部证据仍然缺失或相互矛盾。",
      "",
      "缺失的证据或未完成项：",
      ...report.missing.slice(0, 16).map(item => `- ${item}`),
      "",
      "下一步：",
      "使用工具解决第一个缺失项，运行具体的验证命令，只有当此门可以产生证据报告时才结束。",
    ].join("\n")
  }
  return [
    "## External Completion Gate",
    "You cannot give a final completion answer yet. External evidence is still missing or contradictory.",
    "",
    "Missing evidence or obligations:",
    ...report.missing.slice(0, 16).map(item => `- ${item}`),
    "",
    "Required next step:",
    "Use tools to resolve the first missing item, run the concrete verification command, then only finish when this gate can produce an evidence report.",
  ].join("\n")
}

export function formatBlockedCompletion(report: CompletionGateReport, language?: UILanguage): string {
  if (language === "zh") {
    return [
      "## 完成被阻止",
      "外部证据仍然缺失，无法诚实地标记此任务为完成。",
      "",
      "缺失项：",
      ...report.missing.slice(0, 16).map(item => `- ${item}`),
    ].join("\n")
  }
  return [
    "## Completion blocked",
    "External evidence is still missing, so I cannot honestly mark this task complete.",
    "",
    "Missing:",
    ...report.missing.slice(0, 16).map(item => `- ${item}`),
  ].join("\n")
}

export function formatCompletionEvidenceReport(finalText: string, report: CompletionGateReport, language?: UILanguage): string {
  if (language === "zh") {
    const lines = [
      "## 交付报告",
      compactFinalText(finalText),
      "",
      "## 证据",
      ...(report.evidenceLines.length > 0 ? report.evidenceLines.map(item => `- ${item}`) : ["- 未记录结构化验证结果"]),
    ]
    if (report.changedFiles.length > 0) {
      lines.push("", "## 已变更文件", ...report.changedFiles.slice(0, 12).map(file => `- ${file}`))
    }
    lines.push(
      "",
      "## 风险",
      ...(report.residualRisks.length > 0 ? report.residualRisks.map(item => `- ${item}`) : ["- 无未解决的运行时门风险记录"]),
    )
    return lines.join("\n")
  }
  const lines = [
    "## Delivery Report",
    compactFinalText(finalText),
    "",
    "## Evidence",
    ...(report.evidenceLines.length > 0 ? report.evidenceLines.map(item => `- ${item}`) : ["- no structured verification result was recorded"]),
  ]
  if (report.changedFiles.length > 0) {
    lines.push("", "## Changed Files", ...report.changedFiles.slice(0, 12).map(file => `- ${file}`))
  }
  lines.push(
    "",
    "## Risk",
    ...(report.residualRisks.length > 0 ? report.residualRisks.map(item => `- ${item}`) : ["- no unresolved runtime gate risk recorded"]),
  )
  return lines.join("\n")
}
