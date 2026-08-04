/** LlmAgentNode (H11, plan §17.4) — a single agent as one node.
 *
 *  Reuses the LegacyLoopAdapter (the same bridge the AgentHarness uses) and
 *  buildLoopOptions, so the AgentOptions construction and the loop execution
 *  are structurally identical to the legacy path — parity is by construction,
 *  not by re-implementation. Budget enforcement reuses the H4 BudgetGuard
 *  over the run-level ledger. A single agent IS one LlmAgentNode (acceptance).
 */

import type { AgentNodeInput, AgentNodeOutput, HarnessNode, NodeEvent, NodeExecutionContext, NodeResult, NodeUsage } from "../contracts/nodes"
import type { LegacyLoopAdapterDeps } from "../runtime/legacy-loop-adapter"
import { buildLoopOptions, createLegacyLoopAdapter } from "../runtime/legacy-loop-adapter"
import type { HarnessEvent } from "../contracts/events"
import { BudgetGuard } from "../runtime/budget-guard"
import { mapDecisionToOutcome } from "../runtime/outcome-mapper"
import type { LoopDecision } from "../../agent/kernel/types"
import type { AgentRunInput, AgentRun } from "../contracts/run"
import { snapshotEvidence, diffEvidence } from "./context"
import { computeWorkspaceHash } from "../persistence/workspace-hash"
import type { HarnessArtifact } from "../contracts/artifact"

export interface LlmAgentNodeOptions {
  id: string
  deps: LegacyLoopAdapterDeps
}

export function createLlmAgentNode(nodeOptions: LlmAgentNodeOptions): HarnessNode<AgentNodeInput, AgentNodeOutput> {
  const adapter = createLegacyLoopAdapter({ deps: nodeOptions.deps })
  let result: NodeResult<AgentNodeOutput> | null = null

  return {
    id: nodeOptions.id,
    kind: "llm_agent",

    async *execute(context: NodeExecutionContext, input: AgentNodeInput): AsyncGenerator<NodeEvent> {
      const runInput: AgentRunInput = {
        prompt: input.prompt,
        tools: input.tools,
        maxRounds: input.maxRounds,
        budget: input.budget,
        metadata: input.metadata,
      }

      // Run shim: the node executes against the run's scope and budget; only
      // the fields buildLoopOptions reads are consumed (LoopRunContext).
      const run = {
        runId: context.runId,
        sessionId: context.runScope.sessionId,
        status: "running",
        input: runInput,
        scope: context.runScope,
        budget: context.budget,
        createdAt: Date.now(),
        eventSequence: 0,
        schemaVersion: 1,
      } as AgentRun

      const loopOptions = buildLoopOptions(run, runInput, nodeOptions.deps, context.cancellation.signal)
      const guard = new BudgetGuard(context.budget, (reason) => context.cancellation.cancel(reason))

      let finalText = ""
      const usage: NodeUsage = { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cacheMissTokens: 0, wallTimeMs: 0 }
      let decision: LoopDecision = { kind: "continue" }

      // R1: evidence chain — snapshot ledger + artifact store before the loop;
      // the node's output is the diff (entries/artifacts ADDED by this node).
      const evidenceSnapshot = snapshotEvidence(context.runScope.evidenceLedger)
      const artifactSnapshot = new Set((await context.runScope.artifactStore.entries()).map((a) => a.artifactId))

      const iterator = adapter.execute(run, runInput, context.cancellation.signal)
      while (true) {
        const step = await iterator.next()
        if (step.done) {
          decision = step.value as LoopDecision
          break
        }
        const envelope = step.value
        if (!guard.observe(envelope)) {
          // Budget exhausted — abort was fired; stop the loop and let the
          // iterator's own finally close provider/tool resources.
          await iterator.return(undefined as never)
          decision = { kind: "return", reason: "aborted" }
          break
        }
        yield* translateEnvelope(envelope, context, usage, (text) => { finalText = text })
      }

      const cancelled = context.cancellation.cancelled
      const outcome = mapDecisionToOutcome(decision, undefined, cancelled ? context.cancellation.reason : undefined).outcome

      // R1: evidence-backed node commit — the diff the Graph Scheduler will
      // need to judge/commit this node (audit: P0-2).
      const newEvidence = diffEvidence(context.runScope.evidenceLedger, evidenceSnapshot)
      const newArtifacts: HarnessArtifact[] = (await context.runScope.artifactStore.entries())
        .filter((a) => !artifactSnapshot.has(a.artifactId))
      const nodeOutput: AgentNodeOutput = {
        text: finalText,
        decision,
        outcome,
        usage,
        evidenceIds: newEvidence.map((e) => e.id),
        artifactIds: newArtifacts.map((a) => a.artifactId),
        patchTransactionIds: newArtifacts
          .filter((a) => a.kind === "patch" && a.txId)
          .map((a) => a.txId as string),
        // Honest unknown[] until the typed ripple trace lands (scope.ts).
        unresolvedRippleObligations: context.runScope.rippleSession.obligations,
        resultingWorkspaceDigest: computeWorkspaceHash(context.runScope.projectRoot),
      }

      if (cancelled) {
        result = { status: "cancelled", output: nodeOutput, evidence: newEvidence, diagnostics: [], usage, retryable: false }
      } else if (decision.kind === "break" && decision.reason === "orchestrator_done") {
        result = { status: "succeeded", output: nodeOutput, evidence: newEvidence, diagnostics: [], usage }
      } else if (decision.kind === "break" && decision.reason === "round_budget" && finalText) {
        result = { status: "succeeded", output: nodeOutput, evidence: newEvidence, diagnostics: [{ code: "round_budget", message: "natural end", severity: "info", source: nodeOptions.id }], usage }
      } else if (decision.kind === "break" && (decision.reason === "orchestrator_plan_ready" || decision.reason === "orchestrator_blocked")) {
        result = {
          status: "blocked",
          output: nodeOutput,
          evidence: newEvidence,
          diagnostics: [{ code: "interrupt_pending", message: decision.reason, severity: "warning", source: nodeOptions.id }],
          usage,
        }
      } else if (decision.kind === "return" && (decision.reason === "clarification" || decision.reason === "prompt_blocked")) {
        result = {
          status: "blocked",
          output: nodeOutput,
          evidence: newEvidence,
          diagnostics: [{ code: "interrupt_pending", message: decision.reason, severity: "warning", source: nodeOptions.id }],
          usage,
        }
      } else {
        result = {
          status: "failed",
          output: nodeOutput,
          evidence: newEvidence,
          diagnostics: [{ code: "loop_failed", message: decision.kind === "return" ? decision.reason : decision.kind, severity: "error", source: nodeOptions.id }],
          usage,
          retryable: false,
        }
      }
    },

    async getResult(): Promise<NodeResult<AgentNodeOutput>> {
      if (!result) throw new Error(`node ${nodeOptions.id} getResult called before execute`)
      return result
    },
  }
}

/** Translate one bridged HarnessEvent into NodeEvents (side stream). */
function* translateEnvelope(
  envelope: HarnessEvent,
  context: NodeExecutionContext,
  usage: NodeUsage,
  onText: (text: string) => void,
): Generator<NodeEvent> {
  const payload = envelope.payload
  if ("text" in payload) {
    const text = payload.text
    onText(text)
    yield { type: "node.text", nodeRunId: context.nodeRunId, text }
  } else if ("toolCall" in payload) {
    yield {
      type: "node.tool.call",
      nodeRunId: context.nodeRunId,
      toolCall: { id: payload.toolCall.id, name: payload.toolCall.name, input: payload.toolCall.input, sideEffect: payload.toolCall.sideEffect },
    }
  } else if ("toolName" in payload) {
    yield { type: "node.tool.result", nodeRunId: context.nodeRunId, toolName: payload.toolName, success: payload.success, content: payload.content }
  } else if ("usage" in payload) {
    const u = payload.usage as { inputTokens?: number; outputTokens?: number; cacheMissInputTokens?: number; cacheSource?: string }
    // Provider-sourced usage only (estimate events carry whole-round totals).
    // The kernel's provider events are CUMULATIVE snapshots (round N carries
    // rounds 1..N), so we take the last value rather than accumulate —
    // accumulation would double-count (noted: the H4 BudgetGuard += has the
    // same hazard on real kernel streams; tracked for H12).
    if (u.cacheSource === "provider") {
      usage.inputTokens = u.inputTokens ?? usage.inputTokens
      usage.outputTokens = u.outputTokens ?? usage.outputTokens
      usage.cacheMissTokens = u.cacheMissInputTokens ?? usage.cacheMissTokens
      yield { type: "node.usage", nodeRunId: context.nodeRunId, usage: { ...usage } }
    }
  } else if ("error" in payload) {
    yield { type: "node.error", nodeRunId: context.nodeRunId, error: { kind: "loop_error", message: payload.error, retryable: false } }
  } else if ("interrupt" in payload) {
    const interrupt = payload.interrupt as { kind?: string; prompt?: string; responseSchema?: unknown }
    yield {
      type: "node.interrupt",
      nodeRunId: context.nodeRunId,
      kind: (interrupt.kind ?? "plan_approval") as "plan_approval" | "clarification",
      prompt: interrupt.prompt ?? "",
      responseSchema: (interrupt.responseSchema ?? { type: "object" }) as never,
    }
  } else if ("planReady" in payload) {
    yield { type: "node.interrupt", nodeRunId: context.nodeRunId, kind: "plan_approval", prompt: "plan approval required", responseSchema: { type: "object" } as never }
  } else if ("clarification" in payload) {
    yield { type: "node.interrupt", nodeRunId: context.nodeRunId, kind: "clarification", prompt: "clarification required", responseSchema: { type: "object" } as never }
  }
}
