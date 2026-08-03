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
 * projection. The authoritative typecheck (round batch tsc) is ingested into
 * EvidenceLedger and lastTypecheck is derived from the ledger for that path.
 * Ripple "assume-pass" and per-tool output heuristics stay as compat projections
 * because they are not authoritative verification evidence (ingesting them would
 * let the completion gate pass on unverified claims).
 */

import type { ProviderMessage, StreamEvent } from "../../provider/types"
import type { AgentRunState, RoundState } from "../run/types"
import type { PlanStore } from "../run/plan-store"
import type { AgentRunTrace } from "../run-trace"
import type { EvidenceLedger } from "../evidence-ledger"
import { deriveLastTypecheck, ingestTypecheck, ingestVerificationResults } from "../evidence-ledger"
import type { ArtifactStore } from "../../harness/contracts/artifact"
import { ingestTypecheckWithArtifact, ingestVerificationWithArtifact, putRippleArtifact } from "../../harness/artifacts/evidence-adapter"
import { computeRelevantFileHashes } from "../../harness/artifacts/freshness"
import { runRippleVerification } from "../round/post-loop"
import {
  getBlockingObligations,
  mergeObligations,
  obligationsFromReport,
  resolveObligations,
} from "../../ripple/obligations"
import { setCascadeFiles } from "../../ripple/engine"
import { checkNarrowEditCompletion } from "../completion-orchestrator"
import { formatRuntimeSelfEditGate, isRuntimeSourceFile, missingExplicitRequiredFiles, rootRuntimeVerificationPassed } from "../round/pre-loop"
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
  /** H8: harness-owned artifact store — when present, verification results are
   *  ingested as artifacts bound to their evidence entries (§14.2). */
  artifactStore?: ArtifactStore
  /** H8: run id stamped on produced artifacts. */
  runId?: string

  modifiedFilesThisRound: Set<string>
  rippleReportsThisRound: RippleReport[]
  verificationResultsThisRound: VerificationResult[]
  toolNames: string[]

  rawMessages: ProviderMessage[]
  resultsContent: Array<Record<string, unknown>>

  runTrace?: AgentRunTrace
  planStore: PlanStore
  /** Round budget for runtime-self-edit gate continuation decisions. */
  maxRounds?: number
}

// ── Part 1: bind structured verification to the canonical ledger ──

/**
 * Ingest this round's structured verification results into EvidenceLedger.
 * Ran immediately after tool execution so completion gates see fresh evidence.
 * H8: with an artifact store present, each result also becomes a bound
 * artifact (typecheck_result/test_result/build_result) so freshness
 * invalidation can mark both sides stale (§14.2/§14.3).
 */
export async function bindVerificationToLedger(ctx: VerificationContext): Promise<void> {
  const { artifactStore, evidenceLedger, verificationResultsThisRound, modifiedFilesThisRound, runId } = ctx
  if (!artifactStore) {
    ingestVerificationResults(evidenceLedger, verificationResultsThisRound, undefined, getWriteGeneration())
    return
  }
  const relevantFileHashes = modifiedFilesThisRound.size > 0
    ? computeRelevantFileHashes(process.cwd(), [...modifiedFilesThisRound])
    : undefined
  for (const result of verificationResultsThisRound) {
    await ingestVerificationWithArtifact({
      store: artifactStore,
      ledger: evidenceLedger,
      runId: runId ?? "",
      result,
      producedBy: result.command || "verification",
      generation: getWriteGeneration(),
      relevantFileHashes,
    })
  }
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
    // H9: ripple verification reports are run-flow facts — record one
    // ripple_report artifact per round when a harness store is present
    // (same injection chain as the H8 typecheck/verification artifacts).
    if (ctx.artifactStore && ctx.runId && rippleReportsThisRound.length > 0) {
      const report = rippleReportsThisRound
        .map((r) => `${r.targetFile}: ${r.findings.length} findings`)
        .join("; ")
      try {
        await putRippleArtifact({
          store: ctx.artifactStore,
          runId: ctx.runId,
          report,
          producedBy: "ripple_engine",
        })
      } catch {
        // Best-effort: artifact recording never breaks the run.
      }
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
    // L5: the batch tsc result is the authoritative typecheck for the round —
    // ingest it into EvidenceLedger and derive the lastTypecheck compat view
    // from the ledger (single source of truth for completion).
    // H8: with an artifact store present the result also becomes a
    // typecheck_result artifact bound to its evidence entry.
    if (ctx.artifactStore) {
      await ingestTypecheckWithArtifact({
        store: ctx.artifactStore,
        ledger: ctx.evidenceLedger,
        runId: ctx.runId ?? "",
        passed: tscResult.available ? tscResult.passed : true,
        issues: tscResult.available ? tscResult.issues : 0,
        output: tscResult.available ? tscResult.output : (tscResult.output || "tsc unavailable"),
        command: "tsc --noEmit",
        producedBy: "batch_typecheck",
        generation: getWriteGeneration(),
        relevantFileHashes: computeRelevantFileHashes(process.cwd(), tsFilesWritten),
      })
    } else {
      ingestTypecheck(ctx.evidenceLedger, {
        passed: tscResult.available ? tscResult.passed : true,
        issues: tscResult.available ? tscResult.issues : 0,
        output: tscResult.available ? tscResult.output : (tscResult.output || "tsc unavailable"),
        command: "tsc --noEmit",
        generation: getWriteGeneration(),
      })
    }
    const derivedTypecheck = deriveLastTypecheck(ctx.evidenceLedger)
    if (derivedTypecheck) verificationState.lastTypecheck = derivedTypecheck
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

// ── Part 4: Runtime self-edit gate ──

export interface RuntimeSelfEditOutput {
  /** Control signal back to loop.ts — "break"/"continue" mirror the original inline exits. */
  action: "break" | "continue" | "next"
}

/**
 * Runtime self-edit gate: if the agent modified files under src/agent, src/tools,
 * etc., the running process cannot hot-load them. Once a root typecheck passes,
 * the run must stop for a restart. Returns a control signal so loop.ts can
 * `break` / `continue` exactly as the pre-extraction inline block did.
 */
export async function* runRuntimeSelfEditGate(
  ctx: VerificationContext,
): AsyncGenerator<StreamEvent, RuntimeSelfEditOutput, unknown> {
  const { execution, verificationState, modifiedFilesThisRound, verificationResultsThisRound, round, maxRounds } = ctx
  const runtimeFilesThisRound = [...modifiedFilesThisRound].filter(path => isRuntimeSourceFile(path))
  if (runtimeFilesThisRound.length > 0) {
    execution.runtimeSelfEditFiles = new Set([...execution.runtimeSelfEditFiles, ...runtimeFilesThisRound])
  }
  if (execution.runtimeSelfEditFiles.size > 0) {
    if (rootRuntimeVerificationPassed(verificationResultsThisRound) || rootRuntimeVerificationPassed(verificationState.lastResults)) {
      const files = [...execution.runtimeSelfEditFiles].sort().join(", ")
      yield { type: "status", data: "runtime-self-edit-gate: verified; restart required" }
      yield {
        type: "text",
        data: `Runtime source changes were verified, but the current DeepSeek Code process cannot hot-load them. Restart DeepSeek Code before continuing. Changed runtime files: ${files}.`,
      }
      ctx.runTrace?.record("gate_decision", { gate: "runtime_self_edit", decision: "restart_required", files: [...execution.runtimeSelfEditFiles].sort() })
      return { action: "break" }
    }
    if ((maxRounds ?? Infinity) > round + 1) {
      ctx.rawMessages.push({ role: "user", content: formatRuntimeSelfEditGate([...execution.runtimeSelfEditFiles].sort()) })
      yield { type: "status", data: "runtime-self-edit-gate: run root typecheck then stop" }
      ctx.runTrace?.record("gate_decision", { gate: "runtime_self_edit", decision: "verify_then_restart", files: [...execution.runtimeSelfEditFiles].sort() })
      return { action: "continue" }
    }
  }
  return { action: "next" }
}
