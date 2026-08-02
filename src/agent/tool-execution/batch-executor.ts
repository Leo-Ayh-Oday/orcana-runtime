/**
 * L4: ToolBatchExecutor — the single execution entry for a round of tool calls.
 *
 * Owns:
 *  - parallel readonly detection + policy preview
 *  - per-tool unified policy (8-layer order preserved, see tool-execution/policy.ts)
 *  - gate telemetry for policy gates
 *  - single-tool execution (via executeSingleTool)
 *  - result normalization / truncation
 *  - ToolLedger recording (blocked / failed / success)
 *  - per-tool post-processing: typecheck detection, verification ingestion,
 *    file-state tracking, staged-context marks, thinking store, self-learn
 *
 * Behavior-frozen from loop.ts. The generator yields the same StreamEvents the
 * caller used to yield inline and returns `{ aborted }` so the caller can stop
 * the outer loop on abort, preserving the original early-return semantics.
 */

import type { AgentRunState, RoundState, RoundToolCall } from "../run/types"
import type { ToolDescriptor } from "../../tools/registry"
import type { HookSystem } from "../../hooks"
import type { AgentRunTrace } from "../run-trace"
import type { ThinkingStore } from "../../memory/thinking-store"
import type { PermissionGate, ToolCategory } from "../permission"
import type { GateTelemetry } from "../gates/telemetry"
import type { ErrorTracker } from "../round/pre-loop"
import type { StagedContextManager } from "../../context/staged"
import type { IntentPolicy } from "../intent"
import type { StreamEvent } from "../../provider/types"
import type { RippleReport } from "../../ripple/types"
import type { VerificationResult } from "../../verification/result"
import { hasServiceTestFailure } from "../../verification/result"
import { normalizeProjectPath } from "../../ripple/obligations"
import { getWriteGeneration, recordRuntimeObservedWrites, recordRuntimeUnmanagedWrite } from "../../file-state"
import { currentTransactionEvidenceBinding } from "../patch-transaction"
import { clipProviderContext } from "../../context/staged"
import { formatToolLedgerStatus, type ToolExecutionLedger } from "../tool-ledger"
import { evaluateToolPolicy, type ToolPolicyResult } from "./policy"
import { executeSingleTool } from "./single-executor"
import { normalizeToolResultContent } from "./result-normalizer"
import { containsTypecheckFailure, countTypecheckIssues, isVerificationUnavailable } from "../round/pre-loop"
import { runPostEditDiagnostics } from "../round/post-loop"
import { getActiveMode } from "../mode-contract"

export interface ToolBatchContext {
  round: number
  completedToolCalls: RoundToolCall[]
  tools: ToolDescriptor[]
  hooks?: HookSystem
  abortSignal?: AbortSignal
  runTrace?: AgentRunTrace
  thinkingStore?: ThinkingStore

  /** Mutable round state — the batch executor updates it in place. */
  roundState: RoundState
  planning: AgentRunState["planning"]
  execution: AgentRunState["execution"]
  verificationState: AgentRunState["verification"]
  notices: AgentRunState["notices"]
  intentPolicy: IntentPolicy

  permissionGate: PermissionGate
  permissionMode: "full" | "strict"
  preRoundCtx: { taskPlanning: boolean }
  contextReadinessBlocked: boolean
  contextReadinessBlockers?: string[]
  finalText: string

  toolLedger: ToolExecutionLedger
  gateTelemetry: GateTelemetry
  errorTracker: ErrorTracker

  stagedContext?: StagedContextManager
  prompt: string
  resultsContent: Array<Record<string, unknown>>

  /** Trusted-verification extraction from a tool result (runtime built-in verifiers). */
  trustedVerification: (
    tool: ToolDescriptor | undefined,
    result: { success: boolean; metadata?: Record<string, unknown> },
  ) => VerificationResult | undefined
}

export interface ToolBatchResult {
  /** True when the batch aborted mid-execution and the outer loop must stop. */
  aborted: boolean
}

const TOOL_GATE_NAMES = [
  "policy:rate_limit",
  "policy:permission",
  "policy:readonly_intent",
  "policy:ripple_block",
  "policy:planning_phase",
  "policy:context_readiness",
  "policy:web_search_failed",
  "policy:mode_contract",
  "policy:tool_risk",
]

function recordPolicyGateTelemetry(gateTelemetry: GateTelemetry, policyResult: ToolPolicyResult): void {
  const blockedGate = policyResult.allowed ? null
    : policyResult.reason.startsWith("permission") ? "policy:permission"
    : policyResult.reason.startsWith("tool_risk") ? "policy:tool_risk"
    : `policy:${policyResult.reason}`
  for (const gn of TOOL_GATE_NAMES) {
    if (gn === blockedGate) {
      gateTelemetry.record(gn, "block")
      break
    }
    gateTelemetry.record(gn, "pass")
  }
}

export async function* executeToolBatch(ctx: ToolBatchContext): AsyncGenerator<StreamEvent, ToolBatchResult, unknown> {
  const {
    round, completedToolCalls, tools, hooks, abortSignal, runTrace, thinkingStore,
    roundState, planning, execution, verificationState, notices, intentPolicy,
    permissionGate, permissionMode, preRoundCtx, contextReadinessBlocked,
    contextReadinessBlockers, finalText,
    toolLedger, gateTelemetry, errorTracker, stagedContext, prompt, resultsContent,
    trustedVerification,
  } = ctx

  const taskTracker = planning.taskTracker
  const toolNames = roundState.toolNames
  const filePaths = roundState.filePaths
  const learnPrompts = roundState.learnPrompts
  const modifiedFilesThisRound = roundState.modifiedFiles
  const rippleReportsThisRound = roundState.rippleReports
  const verificationResultsThisRound = roundState.verificationResults
  const taskFiles = execution.taskFiles

  // ── Parallel readonly candidate detection + policy preview ──
  const parallelCandidate = !preRoundCtx.taskPlanning && completedToolCalls.length > 1 && completedToolCalls.every(tc => {
    const tool = tools.find(t => t.defn.name === tc.name)
    return Boolean(tc.name !== "web_search" && tool && tool.defn.isReadonly && !tool.executeStream && (tool.defn.isConcurrencySafe ?? true))
  })
  const parallelPolicies = new Map<string, ReturnType<typeof evaluateToolPolicy>>()
  if (parallelCandidate) {
    const previewRateLimits: Record<ToolCategory, number> = {
      safe: 0,
      shell: roundState.rateLimits.shell,
      file: roundState.rateLimits.file,
      network: roundState.rateLimits.network,
      git: 0,
    }
    for (const tc of completedToolCalls) {
      const tool = tools.find(t => t.defn.name === tc.name)
      const decision = evaluateToolPolicy({
        toolCall: { id: tc.id, name: tc.name, input: tc.input },
        tool,
        intentPolicy,
        taskTracker,
        rippleBlockActive: execution.rippleBlockActive,
        pendingRippleObligations: verificationState.rippleObligations,
        permissionGate,
        permissionMode,
        rateLimits: previewRateLimits,
        webSearchFailedThisTurn: notices.webSearchFailedThisTurn,
        webSearchFailReason: notices.webSearchFailReason,
        finalText,
        contextReadinessBlocked,
        contextReadinessBlockers,
        modeContract: getActiveMode(),
      })
      parallelPolicies.set(tc.id, decision)
      if (decision.incrementRateLimit) previewRateLimits[decision.incrementRateLimit]++
    }
  }
  const parallelReadonly = parallelCandidate
    && completedToolCalls.every(tc => parallelPolicies.get(tc.id)?.allowed === true)
  const parallelResults = new Map<string, { content: string; success: boolean; metadata?: Record<string, unknown>; startedAt: number }>()
  if (parallelReadonly) {
    yield { type: "status", data: `greedy-tools: ${completedToolCalls.length} readonly calls` }
    const results = await Promise.all(completedToolCalls.map(async tc => {
      const tool = tools.find(t => t.defn.name === tc.name)!
      const startedAt = Date.now()
      try {
        const result = await executeSingleTool({
          tool,
          params: tc.input,
          hooks,
          abortSignal,
        })
        return { id: tc.id, content: result.result.content, success: result.result.success, metadata: result.result.metadata, startedAt: result.startedAt }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return { id: tc.id, content: message, success: false, metadata: undefined, startedAt }
      }
    }))
    for (const result of results) parallelResults.set(result.id, result)
    if (abortSignal?.aborted) return { aborted: true }
  }

  for (const tc of completedToolCalls) {
    toolNames.push(tc.name)
    runTrace?.record("tool_call", { round, id: tc.id, tool: tc.name, input: tc.input })
    const tool = tools.find(t => t.defn.name === tc.name)
    let resultContent = "Unknown tool"
    let resultObj: { success: boolean; content: string; metadata?: Record<string, unknown> } = { success: false, content: "" }
    let toolStartedAt = Date.now()
    const transactionBindingBeforeTool = currentTransactionEvidenceBinding()

    if (preRoundCtx.taskPlanning && round > 0) {
      resultContent = `任务追踪已阻止：当前是计划专用回合，只允许输出计划，不允许调用 ${tc.name}。下一轮将进入执行阶段。`
      resultObj = { success: false, content: resultContent, metadata: { blocked: true, planOnlyRound: true } }
      resultsContent.push({ type: "tool_result", tool_use_id: tc.id, content: clipProviderContext(resultContent, 4000) })
      continue
    }

    // ── Unified tool execution policy — all gates in one pure function ──
    const policyResult = parallelPolicies.get(tc.id) ?? evaluateToolPolicy({
      toolCall: { id: tc.id, name: tc.name, input: tc.input },
      tool,
      intentPolicy,
      taskTracker,
      rippleBlockActive: execution.rippleBlockActive,
      pendingRippleObligations: verificationState.rippleObligations,
      permissionGate,
      permissionMode,
      rateLimits: {
        safe: 0,
        shell: roundState.rateLimits.shell,
        file: roundState.rateLimits.file,
        network: roundState.rateLimits.network,
        git: 0,
      },
      webSearchFailedThisTurn: notices.webSearchFailedThisTurn,
      webSearchFailReason: notices.webSearchFailReason,
      finalText,
      contextReadinessBlocked,
      contextReadinessBlockers,
      modeContract: getActiveMode(),
    })

    // ── Gate telemetry for tool policy gates ──
    recordPolicyGateTelemetry(gateTelemetry, policyResult)

    // Track rate limits regardless of outcome
    if (policyResult.incrementRateLimit === "shell") roundState.rateLimits.shell++
    else if (policyResult.incrementRateLimit === "file") roundState.rateLimits.file++
    else if (policyResult.incrementRateLimit === "network") roundState.rateLimits.network++

    if (!policyResult.allowed) {
      resultContent = policyResult.blockMessage
      resultObj = { success: false, content: resultContent }
      // Hard blocks (rate_limit, permission:deny) push immediately and skip yield.
      // Soft blocks (readonly, ripple, planning, web_search) fall through to yield.
      if (policyResult.reason === "rate_limit" || policyResult.reason.startsWith("permission:")) {
        // L4: hard-blocked calls still get a ledger entry so every outcome is
        // recorded (blocked/failed/success/aborted). Pre-L4 loop.ts skipped it.
        const blockedLedgerEntry = toolLedger.record({
          id: tc.id,
          round,
          tool: tc.name,
          startedAt: toolStartedAt,
          result: { ...resultObj, metadata: { ...resultObj.metadata, blocked: true, gate: policyResult.source } },
          changedFiles: [],
        })
        runTrace?.record("tool_result", blockedLedgerEntry)
        yield { type: "status", data: formatToolLedgerStatus(blockedLedgerEntry) }
        resultsContent.push({ type: "tool_result", tool_use_id: tc.id, content: clipProviderContext(resultContent, 4000) })
        continue
      }
    }

    if (tool && policyResult.allowed) {
      const parallelResult = parallelResults.get(tc.id)
      try {
        const executed = await executeSingleTool({
          tool,
          params: tc.input,
          hooks,
          abortSignal,
          parallelResult,
        })
        resultContent = executed.result.content
        resultObj = { success: executed.result.success, content: executed.result.content, metadata: executed.result.metadata }
        toolStartedAt = executed.startedAt
      } catch (e) {
        resultContent = e instanceof Error ? e.message : String(e)
        resultObj = { success: false, content: resultContent }
      }
    }
    if (abortSignal?.aborted) return { aborted: true }
    const changedFilesForLedger = new Set<string>()
    // ── Smart truncation: head+tail with error-aware allocation ──
    resultContent = normalizeToolResultContent(resultContent, resultObj.success)

    yield {
      type: "tool_result",
      data: { name: tc.name, content: resultContent.slice(0, 500), success: resultObj.success },
    }
    if (tc.name === "web_search" && !resultObj.success) {
      notices.webSearchFailedThisTurn = true
      notices.webSearchFailReason = resultContent.slice(0, 200)
    }
    if (tc.name === "request_deeper_thinking" && resultObj.success) {
      execution.requestedMaxThinking = true
      yield { type: "status", data: "深度思考: 模型请求升级到 max 32K" }
    }

    // AskUser tool: yield user_question event to pause agent loop
    if (tc.name === "ask_user" && resultObj.success && resultObj.metadata?.pendingQuestion) {
      yield { type: "user_question", data: resultObj.metadata.pendingQuestion }
    }

    // Self-learn: detect repeated errors
    if (!resultObj.success || /[ef]ail|[ef]rr|blocked|not found|denied/i.test(resultContent)) {
      roundState.hadToolError = true
      execution.toolErrors += 1
      execution.consecutiveErrors += 1
      const learnPrompt = errorTracker.record(tc.name, resultContent)
      if (learnPrompt) learnPrompts.push(learnPrompt)
    } else {
      execution.consecutiveErrors = 0
    }
    if (containsTypecheckFailure(resultContent)) {
      verificationState.lastTypecheck = {
        passed: isVerificationUnavailable(resultContent),
        issues: countTypecheckIssues(resultContent),
        output: resultContent.slice(0, 1000),
      }
    } else if (tc.name === "shell" && /\btsc\b|typescript|typecheck/i.test(String(tc.input.command ?? "")) && !resultObj.success) {
      const unavailable = isVerificationUnavailable(resultContent)
      verificationState.lastTypecheck = {
        passed: unavailable,
        issues: unavailable ? 0 : 1,
        output: resultContent.slice(0, 1000),
      }
    }
    const verification = trustedVerification(tool, resultObj)
    if (verification) {
      const stampedVerification: VerificationResult = {
        ...verification,
        generation: getWriteGeneration(),
        transaction: currentTransactionEvidenceBinding(),
      }
      verificationResultsThisRound.push(stampedVerification)
      runTrace?.record("verification_result", stampedVerification)
      if (stampedVerification.kind === "typecheck") {
        verificationState.lastTypecheck = {
          passed: stampedVerification.passed,
          issues: stampedVerification.issues,
          output: stampedVerification.summary,
        }
      }
      if (stampedVerification.passed) roundState.verificationPassed = true
      if (!stampedVerification.passed && stampedVerification.kind === "test" && hasServiceTestFailure(resultContent)) {
        roundState.serviceTestGuidanceNeeded = true
      }
    }

    const path = tc.input.path as string | undefined
    if (path) {
      filePaths.push(path)
      taskFiles.add(normalizeProjectPath(path))
      const isWriteTool = tc.name === "write_file" || tc.name === "edit_file" || tc.name === "edit_fim"
      if (resultObj.success && isWriteTool) {
        const normalizedPath = normalizeProjectPath(path)
        modifiedFilesThisRound.add(normalizedPath)
        changedFilesForLedger.add(normalizedPath)
        execution.taskHadWrite = true
        execution.modifiedFileCount += 1
      }
      const rippleReport = resultObj.metadata?.rippleReport as RippleReport | undefined
      if (resultObj.success && rippleReport) {
        rippleReportsThisRound.push(rippleReport)
        modifiedFilesThisRound.add(normalizeProjectPath(rippleReport.targetFile))
      }
      if (stagedContext) {
        if (tc.name === "read_file") stagedContext.markLoaded(path)
        else if (tc.name === "write_file" || tc.name === "edit_file" || tc.name === "edit_fim") {
          stagedContext.markEdited(path)
          runPostEditDiagnostics(path, resultObj)
        }
      }
      if (thinkingStore && (tc.name === "shell" || tc.name === "edit_fim" || tc.name === "write_file")) {
        thinkingStore.store(prompt, `Tool: ${tc.name}\nResult: ${resultContent.slice(0, 500)}`, resultContent.includes("error") || resultContent.includes("Error") ? "fix" : "implement")
      }
    }

    if (resultObj.success && Array.isArray(resultObj.metadata?.paths)) {
      for (const path of resultObj.metadata.paths) {
        if (typeof path === "string") {
          filePaths.push(path)
          const normalized = normalizeProjectPath(path)
          modifiedFilesThisRound.add(normalized)
          changedFilesForLedger.add(normalized)
          taskFiles.add(normalized)
          execution.taskHadWrite = true
          execution.modifiedFileCount += 1
          if (stagedContext) stagedContext.markEdited(path)
        }
      }
    }
    if (resultObj.success && Array.isArray(resultObj.metadata?.rippleReports)) {
      for (const report of resultObj.metadata.rippleReports) {
        rippleReportsThisRound.push(report as RippleReport)
        const normalized = normalizeProjectPath((report as RippleReport).targetFile)
        modifiedFilesThisRound.add(normalized)
        changedFilesForLedger.add(normalized)
      }
    }

    const namedManagedWrite = tc.name === "write_file"
      || tc.name === "edit_file"
      || tc.name === "edit_fim"
      || tc.name === "multi_edit"
    if (resultObj.success && namedManagedWrite) {
      const transactionBindingAfterTool = currentTransactionEvidenceBinding()
      const transactionAdvanced = transactionBindingAfterTool?.stateId !== transactionBindingBeforeTool?.stateId
        || transactionBindingAfterTool?.transactionCount !== transactionBindingBeforeTool?.transactionCount
      if (!transactionAdvanced) {
        if (changedFilesForLedger.size > 0) recordRuntimeObservedWrites([...changedFilesForLedger])
        else recordRuntimeUnmanagedWrite()
      }
    }

    const ledgerEntry = toolLedger.record({
      id: tc.id,
      round,
      tool: tc.name,
      startedAt: toolStartedAt,
      result: resultObj,
      changedFiles: [...changedFilesForLedger],
    })
    runTrace?.record("tool_result", ledgerEntry)
    yield { type: "status", data: formatToolLedgerStatus(ledgerEntry) }

    resultsContent.push({ type: "tool_result", tool_use_id: tc.id, content: clipProviderContext(resultContent, 4000) })
  }

  return { aborted: false }
}
