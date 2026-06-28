/** [PR-3.1] CompletionOrchestrator — unified final gate evaluation.
 *
 *  Replaces the scattered completion decision logic in loop.ts with a single
 *  `evaluate()` method that runs ALL final gates in order and returns ONE decision.
 *
 *  Gate evaluation order:
 *    1. Sync gate chain (RippleExit → PlanningArtifact → TaskTracker → Quality)
 *    2. External completion gate (evaluateCompletionGate)
 *    3. Flash Judge (independent model verification)
 *    4. Evidence hard gate (canClaimDone)
 *    5. Truthfulness gate (finalText vs Evidence cross-check)
 *
 *  Each gate can produce: PASS (proceed), CONTINUE (inject messages, re-loop),
 *  or BREAK (exit agent loop). The orchestrator collects all side effects
 *  (injectMessages, statusMessages, traceEvents, etc.) and returns them
 *  in a structured result — loop.ts simply applies them.
 *
 *  Design invariants:
 *    - Single done decision path: no more inline completion checks in loop.ts
 *    - Fail-closed: any unhandled state returns "continue" (not "done")
 *    - All side effects are collected, not directly executed
 *    - canClaimDone() is the final hard gate before "done"
 */

import type { GateTelemetry } from "./gates/telemetry"
import type { CompletionContext } from "./gates/contexts"
import { createCompletionChain } from "./gates/completion"
import { compactAssistantContext } from "./round/helpers"
import { markPlanAccepted, missingTaskRequirements, formatTaskTrackerPrompt } from "./task-tracker"
import { evaluateCompletionGate, formatBlockedCompletion, formatCompletionEvidenceReport, formatCompletionGatePrompt, needsExternalCompletionGate } from "./completion-gate"
import { FlashJudge, type TestimonyLedger } from "./flash-judge"
import { extractPromises } from "./round/post-loop"
import { canClaimDone, formatCanClaimDoneBlocked, type EvidenceLedger, type CanClaimDoneResult } from "./evidence-ledger"
import type { VerificationResult } from "../verification/result"
import type { RippleObligation } from "../ripple/obligations"
import type { RippleReport } from "../ripple/types"
import type { TaskTracker } from "./task-tracker"
import type { MasterPlan } from "./master-plan"
import type { TaskPacket } from "./task-packet"
import type { UILanguage } from "./language"
import type { AgentRunTrace } from "./run-trace"
import type { ConfidenceEvaluator } from "../evaluator/confidence"

// ── Input ──

export interface CompletionOrchestratorInput {
  round: number
  finalText: string
  intentPolicy: { mode: string; reason: string }
  taskTracker: TaskTracker | null
  pendingRippleObligations: RippleObligation[]
  verificationResults: VerificationResult[]
  changedFiles: string[]
  taskHadWrite: boolean
  taskToolErrors: number
  taskModifiedFiles: number
  lastTypecheck?: { passed: boolean; issues: number; output?: string }
  lastRippleReports: RippleReport[]
  planApproved: boolean
  planningRejections: number
  maxRounds: number
  priorTools: string[]
  priorFiles: Set<string>
  confidenceEvaluator: ConfidenceEvaluator
  evidenceLedger?: EvidenceLedger
  testimonyLedger: TestimonyLedger
  flashJudge: FlashJudge
  masterPlan: MasterPlan | null
  autoApprovePlan: boolean
  language?: UILanguage
  runTrace?: AgentRunTrace
  gateTelemetry?: GateTelemetry
  /** Recent conversation turns for FlashJudge context. Computed in loop.ts. */
  recentTurns?: Array<{ role: string; content: string }>
}

// ── Decision ──

export type OrchestratorDecision =
  | "done"           // All gates passed, task complete
  | "continue"      // Gate blocked, inject messages and re-loop
  | "break_blocked" // Gate blocked at final round, exit with block message
  | "plan_ready"    // Plan ready for user approval

export interface CompletionOrchestratorResult {
  decision: OrchestratorDecision
  /** Messages to inject into rawMessages (for "continue" decisions). */
  injectMessages: Array<{ role: string; content: string }>
  /** Status messages to yield. */
  statusMessages: string[]
  /** Text blocks to yield (evidence report, block message, etc.). */
  yieldTexts: string[]
  /** Break event for plan_ready. */
  breakEvent?: { type: string; data: unknown }
  /** Trace events to record via runTrace. */
  traceEvents: Array<{ gate: string; decision: string; [key: string]: unknown }>
  /** Updated planning rejections count. */
  planningRejections?: number
  /** Whether to activate master plan (auto-approve path). */
  activateMasterPlan?: { planText: string; goal: string; forcePacket?: TaskPacket }
  /** Evidence gate result for diagnostics. */
  evidenceResult?: CanClaimDoneResult
  /** Whether to try node transition (master plan). */
  tryNodeTransition?: boolean
}

// ── Helpers ──

function emptyResult(): CompletionOrchestratorResult {
  return {
    decision: "done",
    injectMessages: [],
    statusMessages: [],
    yieldTexts: [],
    traceEvents: [],
  }
}

// ── Orchestrator ──

export class CompletionOrchestrator {
  /** Evaluate all completion gates and return a single decision.
   *
   *  This replaces the scattered completion logic previously in loop.ts:
   *  - completionChain.evaluateSync() + ctx handling (~60 lines)
   *  - evaluateCompletionGate() + FlashJudge (~80 lines)
   *  - narrow_edit auto-finish (~20 lines)
   *  - missingLongTask final check (~15 lines)
   */
  async evaluate(input: CompletionOrchestratorInput): Promise<CompletionOrchestratorResult> {
    const out = emptyResult()

    // ── Phase 1: Sync gate chain ──
    const syncResult = this.evaluateSyncChain(input, out)
    if (syncResult !== null) return syncResult

    // ── Phase 2: External completion gate ──
    const extResult = this.evaluateExternalGate(input, out)
    if (extResult !== null) return extResult

    // ── Phase 3: Flash Judge ──
    const flashResult = await this.evaluateFlashJudge(input, out)
    if (flashResult !== null) return flashResult

    // ── Phase 4: Evidence hard gate (canClaimDone) ──
    const evidenceOk = this.evaluateEvidenceGate(input, out)
    if (!evidenceOk) return out // already set to "continue" or "break_blocked"

    // ── Phase 5: Truthfulness gate ──
    const truthful = this.evaluateTruthfulnessGate(input, out)
    if (!truthful) return out

    // ── All gates passed ──
    out.decision = "done"
    return out
  }

  // ── Phase 1: Sync gate chain (RippleExit → Planning → TaskTracker → Quality) ──

  private evaluateSyncChain(input: CompletionOrchestratorInput, out: CompletionOrchestratorResult): CompletionOrchestratorResult | null {
    const completionCtx = this.buildCompletionContext(input)
    const completionChain = createCompletionChain()
    const completionResult = completionChain.evaluateSync(completionCtx, input.gateTelemetry)

    // Collect side effects from context
    for (const msg of completionCtx.injectMessages) {
      out.injectMessages.push(msg as { role: string; content: string })
    }
    if (completionCtx.statusMessage) {
      out.statusMessages.push(completionCtx.statusMessage)
    }
    if (completionCtx.traceEvent) {
      out.traceEvents.push(completionCtx.traceEvent)
      input.runTrace?.record("gate_decision", completionCtx.traceEvent)
    }

    const ctxExtra = completionCtx as unknown as Record<string, unknown>

    // Handle planning rejected
    if (ctxExtra._planningRejected) {
      out.planningRejections = input.planningRejections + 1
      return { ...out, decision: "continue" }
    }

    // Handle planning passed → plan_ready or auto-approve
    if (ctxExtra._planningPassed) {
      out.planningRejections = 0
      // Plan ready — yield plan_ready event
      if (completionCtx.shouldBreak && completionCtx.breakEvent && !input.autoApprovePlan) {
        out.decision = "plan_ready"
        out.breakEvent = completionCtx.breakEvent
        return out
      }
      // Auto-approve
      if (completionCtx.breakEvent?.type === "plan_ready") {
        markPlanAccepted(input.taskTracker!)
        const forcePacket = ctxExtra._planningForcePassPacket as TaskPacket | undefined
        out.activateMasterPlan = {
          planText: input.finalText,
          goal: input.taskTracker!.goal,
          forcePacket,
        }
        out.injectMessages.push({ role: "user", content: formatTaskTrackerPrompt(input.taskTracker!) })
        out.statusMessages.push("任务追踪: 规划完成，进入执行阶段")
        out.traceEvents.push({
          gate: "planning",
          decision: "accepted",
          score: ctxExtra._planningScore as number,
          signals: ctxExtra._planningSignals,
        })
        return { ...out, decision: "continue" }
      }
    }

    // Plan approved (user confirmed via UI)
    if (completionResult.reason === "planning_accepted") {
      out.planningRejections = 0
      return { ...out, decision: "continue" }
    }

    // Ripple exit, task tracker, quality — all "continue"
    if (completionResult.reason === "ripple_exit" || completionResult.reason === "task_tracker" || completionResult.reason === "quality") {
      return { ...out, decision: "continue" }
    }

    // All sync gates passed — proceed to external gate
    return null
  }

  // ── Phase 2: External completion gate ──

  private evaluateExternalGate(input: CompletionOrchestratorInput, out: CompletionOrchestratorResult): CompletionOrchestratorResult | null {
    const missingLongTask = missingTaskRequirements(input.taskTracker)

    if (!needsExternalCompletionGate({
      taskTracker: input.taskTracker,
      taskHadWrite: input.taskHadWrite,
      toolErrors: input.taskToolErrors,
    })) {
      // No external gate needed — skip to FlashJudge
      return null
    }

    const completionReport = evaluateCompletionGate({
      finalText: input.finalText,
      taskTracker: input.taskTracker,
      missingTaskRequirements: missingLongTask,
      pendingRippleObligations: input.pendingRippleObligations,
      verificationResults: input.verificationResults,
      changedFiles: input.changedFiles,
      taskHadWrite: input.taskHadWrite,
      toolErrors: input.taskToolErrors,
      lastTypecheck: input.lastTypecheck,
      evidenceLedger: input.evidenceLedger,
    })

    if (!completionReport.allowed && input.round + 1 < input.maxRounds) {
      // Blocked but has rounds left — inject prompt and continue
      out.injectMessages.push({ role: "assistant", content: compactAssistantContext(input.finalText) })
      out.injectMessages.push({ role: "user", content: formatCompletionGatePrompt(completionReport, input.language) })
      out.statusMessages.push(`external-completion-gate: blocked (${completionReport.missing.length} missing)`)
      out.traceEvents.push({ gate: "external_completion", decision: "continue", missing: completionReport.missing })
      return { ...out, decision: "continue" }
    }

    if (!completionReport.allowed) {
      // Blocked at final round — exit with block message
      out.statusMessages.push(`external-completion-gate: blocked (${completionReport.missing.length} missing)`)
      out.yieldTexts.push(formatBlockedCompletion(completionReport, input.language))
      out.traceEvents.push({ gate: "external_completion", decision: "blocked", missing: completionReport.missing })
      return { ...out, decision: "break_blocked" }
    }

    // External gate passed — record evidence
    out.statusMessages.push("external-completion-gate: evidence accepted")
    out.yieldTexts.push(formatCompletionEvidenceReport(input.finalText, completionReport, input.language))
    out.traceEvents.push({ gate: "external_completion", decision: "accepted", evidence: completionReport.evidenceLines })

    return null // proceed to FlashJudge
  }

  // ── Phase 3: Flash Judge ──

  private async evaluateFlashJudge(input: CompletionOrchestratorInput, out: CompletionOrchestratorResult): Promise<CompletionOrchestratorResult | null> {
    if (!input.flashJudge.shouldEvaluate({
      taskTracker: input.taskTracker,
      taskHadWrite: input.taskHadWrite,
      toolErrors: input.taskToolErrors,
      round: input.round,
    })) {
      // FlashJudge not needed — check master plan node transition
      if (input.masterPlan) {
        out.tryNodeTransition = true
      }
      return null // proceed to evidence gate
    }

    out.statusMessages.push("flash-judge: evaluating completion...")
    const missingLongTask = missingTaskRequirements(input.taskTracker)

    const judgeResult = await input.flashJudge.evaluate({
      finalText: input.finalText,
      taskTracker: input.taskTracker,
      missingTaskRequirements: missingLongTask,
      pendingRippleObligations: input.pendingRippleObligations,
      verificationResults: input.verificationResults,
      changedFiles: input.changedFiles,
      taskHadWrite: input.taskHadWrite,
      toolErrors: input.taskToolErrors,
      round: input.round,
      recentTurns: input.recentTurns ?? [],
      testimonyLedger: input.testimonyLedger,
    })

    // Record testimony
    const promisedThisRound = extractPromises(input.finalText)
    input.testimonyLedger.record(input.round, promisedThisRound, judgeResult.evidenceFound)

    if (judgeResult.verdict === "SATISFIED") {
      out.statusMessages.push(`flash-judge: ${judgeResult.evidenceFound.length} evidence items confirmed`)
      if (input.masterPlan) {
        out.tryNodeTransition = true
        out.traceEvents.push({ gate: "master_plan", decision: "next_node", progress: "pending" })
      }
      return null // proceed to evidence gate
    }

    if (judgeResult.verdict === "IMPOSSIBLE") {
      out.yieldTexts.push(FlashJudge.formatImpossiblePrompt(judgeResult.gaps))
      return { ...out, decision: "break_blocked" }
    }

    // NOT_SATISFIED — inject gaps and continue
    out.injectMessages.push({ role: "assistant", content: compactAssistantContext(input.finalText) })
    out.injectMessages.push({ role: "user", content: FlashJudge.formatUnsatisfiedPrompt(judgeResult.gaps) })
    out.statusMessages.push(`flash-judge: not satisfied (${judgeResult.gaps.length} gaps)`)
    out.traceEvents.push({ gate: "flash_judge", decision: "continue", gaps: judgeResult.gaps })
    return { ...out, decision: "continue" }
  }

  // ── Phase 4: Evidence hard gate (canClaimDone) ──

  private evaluateEvidenceGate(input: CompletionOrchestratorInput, out: CompletionOrchestratorResult): boolean {
    if (!input.evidenceLedger) return true // no ledger → can't check, allow

    const evidenceResult = canClaimDone({
      tracker: input.taskTracker,
      evidence: input.evidenceLedger,
    })

    out.evidenceResult = evidenceResult

    if (!evidenceResult.canClaim) {
      if (input.round + 1 < input.maxRounds) {
        // Blocked but has rounds left
        out.injectMessages.push({ role: "assistant", content: compactAssistantContext(input.finalText) })
        const evidencePrompt = [
          "## 完成被阻止 — 验证证据不足",
          "",
          ...evidenceResult.blocked.map(b => `- **${b}**`),
          "",
          "### 缺失项",
          ...evidenceResult.missing.map(m => `- ${m}`),
          "",
          "请先解决以上缺失项，然后重新尝试完成。",
        ].join("\n")
        out.injectMessages.push({ role: "user", content: evidencePrompt })
        out.statusMessages.push(`evidence-gate: blocked (${evidenceResult.missing.length} missing)`)
        out.traceEvents.push({ gate: "evidence", decision: "continue", missing: evidenceResult.missing })
        out.decision = "continue"
        return false
      }
      // Final round — block
      out.yieldTexts.push(formatCanClaimDoneBlocked(evidenceResult))
      out.traceEvents.push({ gate: "evidence", decision: "blocked", missing: evidenceResult.blocked })
      out.decision = "break_blocked"
      return false
    }

    // Evidence gate passed
    out.statusMessages.push("evidence-gate: passed")
    out.traceEvents.push({ gate: "evidence", decision: "accepted", satisfiedKinds: evidenceResult.satisfiedKinds })
    return true
  }

  // ── Phase 5: Truthfulness gate ──

  private evaluateTruthfulnessGate(input: CompletionOrchestratorInput, out: CompletionOrchestratorResult): boolean {
    // Cross-check: if model claims verification passed but no evidence exists
    const claims = this.extractTruthClaims(input.finalText)
    if (claims.length === 0) return true // no claims to verify

    const contradictions = this.checkClaimEvidenceContradictions(claims, input)
    if (contradictions.length === 0) return true

    if (input.round + 1 < input.maxRounds) {
      out.injectMessages.push({ role: "assistant", content: compactAssistantContext(input.finalText) })
      const prompt = [
        "## 真实性检查 — 声明与证据矛盾",
        "",
        "你在最终陈述中做出了以下声明，但验证证据不支持：",
        ...contradictions.map(c => `- **${c.claim}**: ${c.contradiction}`),
        "",
        "请要么提供缺失的验证证据，要么修正你的声明。",
      ].join("\n")
      out.injectMessages.push({ role: "user", content: prompt })
      out.statusMessages.push(`truthfulness-gate: ${contradictions.length} contradictions`)
      out.traceEvents.push({ gate: "truthfulness", decision: "continue", contradictions: contradictions.length })
      out.decision = "continue"
      return false
    }

    // Final round — note contradiction but allow (don't block forever)
    out.statusMessages.push(`truthfulness-gate: ${contradictions.length} contradictions (final round — noted)`)
    out.traceEvents.push({ gate: "truthfulness", decision: "noted", contradictions: contradictions.length })
    return true
  }

  // ── Truth claim extraction ──

  /** Patterns that indicate future tense — these are NOT completion claims. */
  private static readonly FUTURE_PATTERNS = [
    /将会?|将要|打算|准备|需要确保|需要保证|下一步|接下来/,
    /will\s+be|going\s+to|need\s+to\s+ensure|should\s+pass|must\s+pass|next\s+step/i,
  ]

  /** Check if text looks like a future-tense statement (not a completion claim). */
  private isFutureTense(text: string): boolean {
    return CompletionOrchestrator.FUTURE_PATTERNS.some(p => p.test(text))
  }

  /** Patterns for claims about verification evidence in final agent text.
   *
   *  Each pattern is a pair: [claim pattern, future-tense filter].
   *  The claim pattern matches statements of completed verification.
   *  The future-tense filter excludes statements about planned/future actions.
   */
  private extractTruthClaims(text: string): TruthClaim[] {
    const claims: TruthClaim[] = []

    // Skip future-tense statements entirely — they're not completion claims
    if (this.isFutureTense(text)) return claims

    // Typecheck claims
    if (/(?:typecheck|tsc|类型检查)\s*(?:通过|passed|成功|0\s*errors?)/i.test(text)) {
      claims.push({ kind: "typecheck", claim: "类型检查通过", pattern: "typecheck_passed" })
    }

    // Test claims
    if (/(?:test|测试)\s*(?:通过|passed|成功|全部|all\s*pass)/i.test(text)) {
      claims.push({ kind: "test", claim: "测试全部通过", pattern: "tests_passed" })
    }

    // Build claims
    if (/(?:build|构建|打包)\s*(?:成功|通过|passed|succeeded)/i.test(text)) {
      claims.push({ kind: "build", claim: "构建成功", pattern: "build_passed" })
    }

    // Lint claims
    if (/(?:lint|eslint)\s*(?:通过|passed|无错误|no\s*errors?|0\s*errors?)/i.test(text)) {
      claims.push({ kind: "typecheck", claim: "Lint 检查通过", pattern: "lint_passed" })
    }

    // Generic "all tests pass" claim
    if (/(?:所有|全部|all)\s*(?:测试|验证|检查|tests?|checks?|verifications?)\s*(?:通过|passed|成功)/i.test(text)) {
      claims.push({ kind: "test", claim: "所有测试/验证通过", pattern: "all_verification_passed" })
    }

    // "No errors" claim (only if no more specific typecheck claim exists)
    if (/(?:no\s*errors?|0\s*errors?|零错误|没有错误|无错误)/i.test(text) && !claims.some(c => c.pattern === "typecheck_passed")) {
      claims.push({ kind: "typecheck", claim: "无编译错误", pattern: "no_errors" })
    }

    return claims
  }

  /** Check if claimed verification is backed by evidence. */
  private checkClaimEvidenceContradictions(claims: TruthClaim[], input: CompletionOrchestratorInput): TruthContradiction[] {
    const contradictions: TruthContradiction[] = []

    for (const claim of claims) {
      switch (claim.pattern) {
        case "typecheck_passed":
        case "no_errors":
        case "lint_passed": {
          // Check typecheck evidence
          const hasTypecheckEvidence = input.evidenceLedger
            ? input.evidenceLedger.entries.some(e => e.kind === "typecheck" && e.passed)
            : input.verificationResults.some(v => (v.kind === "typecheck" || v.kind === "lint") && v.passed)
          const hasLastTypecheck = input.lastTypecheck?.passed === true

          if (!hasTypecheckEvidence && !hasLastTypecheck) {
            contradictions.push({
              claim: claim.claim,
              contradiction: "声称类型检查通过，但 EvidenceLedger 中没有 typecheck 通过记录",
            })
          }
          break
        }
        case "tests_passed":
        case "all_verification_passed": {
          const hasTestEvidence = input.evidenceLedger
            ? input.evidenceLedger.entries.some(e => (e.kind === "test") && e.passed)
            : input.verificationResults.some(v => (v.kind === "test" || v.kind === "smoke") && v.passed)

          if (!hasTestEvidence) {
            contradictions.push({
              claim: claim.claim,
              contradiction: "声称测试通过，但 EvidenceLedger 中没有 test 通过记录",
            })
          }
          break
        }
        case "build_passed": {
          const hasBuildEvidence = input.evidenceLedger
            ? input.evidenceLedger.entries.some(e => e.kind === "build" && e.passed)
            : input.verificationResults.some(v => v.kind === "build" && v.passed)

          if (!hasBuildEvidence) {
            contradictions.push({
              claim: claim.claim,
              contradiction: "声称构建成功，但 EvidenceLedger 中没有 build 通过记录",
            })
          }
          break
        }
      }
    }

    return contradictions
  }

  // ── Context builder ──

  private buildCompletionContext(input: CompletionOrchestratorInput): CompletionContext {
    return {
      round: input.round,
      finalText: input.finalText,
      intentPolicy: input.intentPolicy,
      taskTracker: input.taskTracker,
      pendingRippleObligations: input.pendingRippleObligations,
      taskHadWrite: input.taskHadWrite,
      taskToolErrors: input.taskToolErrors,
      taskModifiedFiles: input.taskModifiedFiles,
      lastTypecheck: input.lastTypecheck,
      lastRippleReports: input.lastRippleReports,
      lastVerificationResults: input.verificationResults,
      planApproved: input.planApproved,
      planningRejections: input.planningRejections,
      maxRounds: input.maxRounds,
      priorTools: input.priorTools,
      priorFiles: input.priorFiles,
      confidenceEvaluator: input.confidenceEvaluator,
      // Outputs (initialized empty)
      completionBlockMessage: null,
      shouldBreak: false,
      breakEvent: null,
      statusMessage: "",
      injectMessages: [],
      traceEvent: null,
    }
  }
}

// ── Truth claim types ──

interface TruthClaim {
  kind: "typecheck" | "test" | "build"
  claim: string
  pattern: string
}

interface TruthContradiction {
  claim: string
  contradiction: string
}

// ── Narrow edit auto-complete (extracted from loop.ts post-round) ──

export interface NarrowEditCheckInput {
  autoFinishOnVerifiedWrite?: boolean
  intentMode: string
  hadTsWriteThisRound: boolean
  blockingObligations: number
  lastTypecheckPassed?: boolean
  missingNarrowFiles: string[]
  modifiedFilesThisRound: Set<string>
}

export interface NarrowEditCheckResult {
  /** If set, the completion is auto-satisfied — this is the done text. */
  completionText: string | null
  /** If set, required files are still missing — this is the prompt to inject. */
  missingFilesPrompt: string | null
  missingFilesStatus: string | null
}

/** Check whether a narrow_edit task can auto-complete after verified writes.
 *
 *  Extracted from loop.ts post-round to keep the orchestrator as the single
 *  source of truth for completion decisions.
 */
export function checkNarrowEditCompletion(input: NarrowEditCheckInput): NarrowEditCheckResult {
  if (
    input.autoFinishOnVerifiedWrite &&
    input.intentMode === "narrow_edit" &&
    input.hadTsWriteThisRound &&
    input.blockingObligations === 0 &&
    input.lastTypecheckPassed &&
    input.missingNarrowFiles.length === 0
  ) {
    const files = [...input.modifiedFilesThisRound].sort().join(", ")
    return {
      completionText: `Done. Applied a verified TypeScript cascade edit. TypeScript verification passed. Changed files: ${files}.`,
      missingFilesPrompt: null,
      missingFilesStatus: null,
    }
  }

  if (input.missingNarrowFiles.length > 0) {
    return {
      completionText: null,
      missingFilesPrompt: [
        "## Required files still missing",
        "The user explicitly requested these files, so do not finish yet:",
        ...input.missingNarrowFiles.map(file => `- ${file}`),
        "",
        "Create the missing file(s), then run the requested verification.",
      ].join("\n"),
      missingFilesStatus: `completion-gate: missing requested file ${input.missingNarrowFiles[0]}`,
    }
  }

  return { completionText: null, missingFilesPrompt: null, missingFilesStatus: null }
}
