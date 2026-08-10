/** LoopDecision → RunOutcome mapping (H2).
 *
 *  The legacy kernel's final LoopDecision is the single source of truth for
 *  how a run ended. This exhaustive switch maps every decision to a structured
 *  RunOutcome — the union is closed, so a new LoopDecision branch fails
 *  compilation until it gets an outcome here ("no unclassifiable exit").
 *
 *  reportArtifactId / checkpointId / evidenceIds are placeholders until H8
 *  (artifacts) and H7 (persistent interrupts) land; the kind/blocker/failure
 *  semantics are final.
 */

import type { LoopDecision } from "../../agent/kernel/types"
import type { RunOutcome } from "../contracts/outcome"
import type { RunStatus } from "../contracts/run"

export interface MappedOutcome {
  status: RunStatus
  outcome: RunOutcome
}

export function mapDecisionToOutcome(
  decision: LoopDecision,
  error?: unknown,
  abortReason?: unknown,
): MappedOutcome {
  switch (decision.kind) {
    case "continue":
      // Unreachable from the harness (the orchestrator normalizes it to a
      // round_budget break); defensive fallback.
      return paused("round_budget")

    case "break":
      switch (decision.reason) {
        case "orchestrator_done":
        case "verified_write":
        case "self_edit":
          return {
            status: "completed",
            outcome: { kind: "completed", reportArtifactId: "", evidenceIds: [] },
          }
        case "orchestrator_plan_ready":
          return {
            status: "waiting",
            outcome: { kind: "waiting", interruptId: "plan-approval", checkpointId: "" },
          }
        case "round_budget":
          return paused("round_budget")
        case "context_budget":
          return blocked("context_budget", "Context budget hard block")
        case "orchestrator_blocked":
          return blocked("completion", "Completion gate blocked")
        case "progress_stalled":
          return blocked("progress_stalled", "No progress for 4 consecutive rounds")
        case "empty_round":
          return blocked("empty_round", "No tool calls and no final text")
        case "provider_failure":
          return {
            status: "failed",
            outcome: {
              kind: "failed",
              failure: { kind: "provider_failure", message: "Provider failure", retryable: false },
            },
          }
      }
      break

    case "return":
      switch (decision.reason) {
        case "clarification":
          return {
            status: "waiting",
            outcome: { kind: "waiting", interruptId: "clarification", checkpointId: "" },
          }
        case "prompt_blocked":
          return blocked("prompt_blocked", decision.blockReason ?? "Prompt blocked by hook")
        case "aborted":
          return {
            status: "cancelled",
            outcome: {
              kind: "cancelled",
              reason: abortReason !== undefined
                ? String(abortReason)
                : error instanceof Error ? error.message : "aborted",
            },
          }
        case "tool_batch_aborted":
          return {
            status: "cancelled",
            outcome: { kind: "cancelled", reason: "tool batch aborted" },
          }
      }
      break
  }

  // Defensive: the switch above is exhaustive over the union; reaching here
  // means a future decision variant was added without a mapping.
  return {
    status: "failed",
    outcome: {
      kind: "failed",
      failure: { kind: "unmapped_decision", message: `Unmapped LoopDecision: ${JSON.stringify(decision)}`, retryable: false },
    },
  }
}

function paused(reason: string): MappedOutcome {
  return {
    status: "paused",
    outcome: { kind: "paused", checkpointId: "", reason },
  }
}

function blocked(gate: string, reason: string): MappedOutcome {
  return {
    status: "blocked",
    outcome: { kind: "blocked", blocker: { gate, reason, blockCount: 1 } },
  }
}

/** Failure mapping for exceptions that escape the run (H2: catch → failed). */
export function failureOutcome(error: unknown): MappedOutcome {
  const message = error instanceof Error ? error.message : String(error)
  return {
    status: "failed",
    outcome: {
      kind: "failed",
      failure: { kind: "exception", message, retryable: false, cause: error },
    },
  }
}
