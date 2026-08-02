/**
 * L5: VerificationCoordinator — the single owner of post-round verification.
 *
 * Centralizes the verification concerns that were previously inlined in loop.ts:
 *  - structured verification → EvidenceLedger binding
 *  - Ripple verification + obligation resolution + cascade files
 *  - narrow-edit completion check
 *  - batch typecheck for files written this round
 *  - TaskTracker verification projection + lastResults maintenance
 *
 * loop.ts no longer runs typecheck or manipulates Ripple obligations directly;
 * it calls these functions and consumes their structured outputs.
 *
 * NOTE (L1 ownership): `verificationState.lastTypecheck` remains a compatibility
 * projection. The canonical fact source is EvidenceLedger; deriving lastTypecheck
 * from the ledger instead of writing it here is a later follow-up.
 */

import type { ProviderMessage, StreamEvent } from "../../provider/types"
import type { AgentRunState, RoundState } from "../run/types"
import type { PlanStore } from "../run/plan-store"
import type { AgentRunTrace } from "../run-trace"
import type { EvidenceLedger } from "../evidence-ledger"
import { ingestVerificationResults } from "../evidence-ledger"
import { runRippleVerification } from "../round/post-loop"
import {
  getBlockingObligations,
  mergeObligations,
  obligationsFromReport,
  resolveObligations,
} from "../../ripple/obligations"
import { setCascadeFiles } from "../../ripple/engine"
import { checkNarrowEditCompletion } from "../completion-orchestrator"
import { missingExplicitRequiredFiles } from "../round/pre-loop"
import { runTypeScriptNoEmit } from "../../tools/typescript"
import { formatTaskTrackerStatus, snapshotTaskTracker, updateTaskTrackerAfterTools } from "../task-tracker"
import { getWriteGeneration } from "../../file-state"
import { currentTransactionEvidenceBinding } from "../patch-transaction"
import type { VerificationResult } from "../../verification/result"
import type { RippleReport } from "../../ripple/types"

// ── Shared context shape ──

export interface VerificationContext {
  round: number
  intentPolicy: { mode: string }
  effectivePrompt: string
  options: { autoFinishOnVerifiedWrite?: boolean }

  planning: AgentRunState["planning"]
  execution: AgentRunState["execution"]
  verificationState: AgentRunState["verification"]
  roundState: RoundState
  evidenceLedger: EvidenceLedger

  modifiedFilesThisRound: Set<string>
  rippleReportsThisRound: RippleReport[]
  verificationResultsThisRound: VerificationResult[]
  toolNames: string[]

  rawMessages: ProviderMessage[]
  resultsContent: Array<Record<string, unknown>>

  runTrace?: AgentRunTrace
  planStore: PlanStore
}

// ── Part 1: bind structured verification to the canonical ledger ──

/**
 * Ingest this round's structured verification results into EvidenceLedger.
 * Ran immediately after tool execution so completion gates see fresh evidence.
 */
export function bindVerificationToLedger(ctx: VerificationContext): void {
  ingestVerificationResults(ctx.evidenceLedger, ctx.verificationResultsThisRound, undefined, getWriteGeneration())
}

// ── Part 2: Ripple verification + obligation resolution + narrow-edit completion ──

export interface RippleVerificationOutput {
  postToolRequiredFilesPrompt: string
}

/**
 * Runs the post-round verification phase that follows tool execution:
 * Ripple verification on modified files, obligation resolution / merging,
 * cascade-file promotion, and the narrow-edit auto-completion check.
 * Yields the same status events loop.ts used to yield inline.
 */
export async function* runRippleVerificationPhase(
  ctx: VerificationContext,
): AsyncGenerator<StreamEvent, RippleVerificationOutput, unknown> {
  const { verificationState, roundState, modifiedFilesThisRound, rippleReportsThisRound } = ctx
  let postToolRequiredFilesPrompt = ""

  if (modifiedFilesThisRound.size > 0 || rippleReportsThisRound.length > 0) {
    const rippleVerification = runRippleVerification(modifiedFilesThisRound)
    const hadTsWriteThisRound = [...modifiedFilesThisRound].some(path => path.endsWith(".ts") || path.endsWith(".tsx"))
    if (rippleVerification.passed) {
      verificationState.rippleObligations = resolveObligations(verificationState.rippleObligations, modifiedFilesThisRound)
      if (!verificationState.lastTypecheck || verificationState.lastTypecheck.passed) {
        verificationState.lastTypecheck = { passed: true, issues: 0 }
      }
    } else if (modifiedFilesThisRound.size > 0 && rippleVerification.available) {
      verificationState.lastTypecheck = { passed: false, issues: rippleVerification.issues, output: rippleVerification.output || "ripple verification failed" }
      yield { type: "status", data: "ripple-verification: failed; obligations retained" }
    } else if (modifiedFilesThisRound.size > 0) {
      verificationState.lastTypecheck = { passed: true, issues: 0, output: rippleVerification.output || "tsc unavailable" }
      yield { type: "status", data: "ripple-verification: skipped; tsc unavailable" }
    }
    for (const report of rippleReportsThisRound) {
      verificationState.rippleObligations = mergeObligations(
        verificationState.rippleObligations,
        obligationsFromReport(report, modifiedFilesThisRound),
      )
    }
    if (verificationState.rippleObligations.length > 0) {
      // Let ripple engine know agent is cascading — promotes block→warn
      setCascadeFiles(new Set(verificationState.rippleObligations.map(o => o.targetFile)))
      yield { type: "status", data: `ripple-obligations: pending ${verificationState.rippleObligations.length}` }
      ctx.runTrace?.record("gate_decision", { gate: "ripple_obligations", decision: "continue", pending: verificationState.rippleObligations.length })
    } else {
      setCascadeFiles(new Set())
    }
    const missingNarrowFiles = ctx.intentPolicy.mode === "narrow_edit"
      ? missingExplicitRequiredFiles(ctx.effectivePrompt, modifiedFilesThisRound)
      : []
    // PR-3.1: narrow edit auto-complete extracted to CompletionOrchestrator helper
    const narrowResult = checkNarrowEditCompletion({
      autoFinishOnVerifiedWrite: ctx.options.autoFinishOnVerifiedWrite,
      intentMode: ctx.intentPolicy.mode,
      hadTsWriteThisRound,
      blockingObligations: getBlockingObligations(verificationState.rippleObligations).length,
      lastTypecheckPassed: verificationState.lastTypecheck?.passed,
      missingNarrowFiles,
      modifiedFilesThisRound,
      taskTracker: ctx.planning.taskTracker,
      evidenceLedger: ctx.evidenceLedger,
      evidenceBinding: currentTransactionEvidenceBinding(),
      requireEvidenceBinding: ctx.execution.taskHadWrite || getWriteGeneration() > 0,
    })
    if (narrowResult.completionText) {
      roundState.completionGateText = narrowResult.completionText
    } else if (narrowResult.evidencePrompt) {
      ctx.rawMessages.push({ role: "user", content: narrowResult.evidencePrompt })
      if (narrowResult.evidenceStatus) {
        yield { type: "status", data: narrowResult.evidenceStatus }
      }
      ctx.runTrace?.record("gate_decision", { gate: "semantic:evidence", decision: "continue", missing: narrowResult.evidenceMissing })
      roundState.narrowEditEvidenceBlocked = true
    } else if (narrowResult.missingFilesPrompt) {
      postToolRequiredFilesPrompt = narrowResult.missingFilesPrompt
      if (narrowResult.missingFilesStatus) {
        yield { type: "status", data: narrowResult.missingFilesStatus }
      }
      ctx.runTrace?.record("gate_decision", { gate: "explicit_required_files", decision: "continue", missing: missingNarrowFiles })
    }
  }
  if (rippleReportsThisRound.length > 0) verificationState.lastRippleReports = [...rippleReportsThisRound]

  return { postToolRequiredFilesPrompt }
}

// ── Part 3: batch typecheck + TaskTracker verification projection + lastResults ──

/**
 * Runs one batch typecheck for TS/TSX files written this round, appends
 * diagnostics to the last tool result, updates the TaskTracker verification
 * projection and status, and maintains the verification lastResults view.
 */
export async function* runBatchTypecheckAndTaskTracker(
  ctx: VerificationContext,
): AsyncGenerator<StreamEvent, void, unknown> {
  const { verificationState, modifiedFilesThisRound, verificationResultsThisRound, toolNames, resultsContent } = ctx

  // ── Batch typecheck: run tsc once per round instead of per-file ──
  const tsFilesWritten = [...modifiedFilesThisRound].filter(f => f.endsWith(".ts") || f.endsWith(".tsx"))
  if (tsFilesWritten.length > 0) {
    const tscResult = runTypeScriptNoEmit(process.cwd())
    verificationState.lastTypecheck = tscResult.available
      ? { passed: tscResult.passed, issues: tscResult.issues, output: tscResult.output }
      : { passed: true, issues: 0, output: tscResult.output || "tsc unavailable" }
    if (!tscResult.passed && tscResult.available) {
      const diagLines = tscResult.output
        .split("\n")
        .filter(l => tsFilesWritten.some(f => l.includes(f)))
        .join("\n")
      if (diagLines) {
        const lastResult = resultsContent[resultsContent.length - 1]
        if (lastResult) {
          lastResult.content = String(lastResult.content) + `\n\n[post-round typecheck — fix in next round]\n${diagLines}`
        }
      }
    }
  }

  updateTaskTrackerAfterTools({
    tracker: ctx.planning.taskTracker,
    changedFiles: [...modifiedFilesThisRound],
    toolNames,
    typecheckPassed: verificationState.lastTypecheck?.passed,
    verificationPassed: ctx.roundState.verificationPassed,
    verificationResults: verificationResultsThisRound,
    skipLegacyStepIds: !!ctx.planStore.current,
  })
  if (ctx.planning.taskTracker) {
    const status = formatTaskTrackerStatus(ctx.planning.taskTracker)
    if (status) yield { type: "status", data: status }
    yield { type: "task_progress", data: snapshotTaskTracker(ctx.planning.taskTracker) }
  }
  if (verificationResultsThisRound.length > 0) {
    verificationState.lastResults = [...verificationState.lastResults, ...verificationResultsThisRound].slice(-20)
  }
}
