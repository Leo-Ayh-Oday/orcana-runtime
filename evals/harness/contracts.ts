/**
 * H12 Tier 2 Run Replay contracts (plan §18.2/18.3).
 *
 * A RunReplayCase scripts a full harness run: provider script + tool script +
 * optional interrupt responses, then asserts on outcome / events / artifacts /
 * workspace / budget. RunReplayResult is what the rubric (§18.4) evaluates.
 *
 * ProviderScriptEvent semantics (H12 convention — keep in sync with
 * scripted-provider.ts):
 *   - usage events carry NO round and are treated as the provider's
 *     per-round increments; the kernel cumulates them into the final
 *     provider usage snapshot (delta accounting in the BudgetGuard).
 *   - purpose-tagged events only serve streamChat calls with that purpose
 *     (e.g. flash_triage); untagged events serve agent_main.
 *   - round_end marks a round boundary (consumed, not yielded).
 */

import type { AgentRunInput } from "../../src/harness/contracts/run"
import type { RunOutcomeKind } from "../../src/harness/contracts/outcome"
import type { BudgetExhaustionReason, BudgetUsage } from "../../src/harness/contracts/budget"
import type { ProviderCallPurpose } from "../../src/provider/types"

export type { ProviderCallPurpose }

export interface ProviderScriptEventBase {
  /** Only serves streamChat calls with this purpose (default: agent_main). */
  purpose?: ProviderCallPurpose
}

export type ProviderScriptEvent =
  | (ProviderScriptEventBase & { type: "text"; data: string })
  | (ProviderScriptEventBase & { type: "tool_call"; name: string; input: unknown })
  | (ProviderScriptEventBase & { type: "usage"; input: number; output: number; cacheMiss?: number })
  | (ProviderScriptEventBase & { type: "error"; errorType: "retryable" | "non_retryable"; message?: string })
  | (ProviderScriptEventBase & { type: "idle_timeout" })
  | (ProviderScriptEventBase & { type: "plan_ready"; planText: string })
  | (ProviderScriptEventBase & { type: "clarification_ready"; questions: unknown })
  | (ProviderScriptEventBase & { type: "status"; data: string })
  | (ProviderScriptEventBase & { type: "thinking_blocks"; data: unknown })
  | (ProviderScriptEventBase & { type: "round_end" })

export interface ToolScriptStep {
  content: string
  success?: boolean
  metadata?: Record<string, unknown>
}

/** Tool outputs by tool name, consumed in call order; last step repeats. */
export interface ToolScriptResult {
  toolName: string
  steps: ToolScriptStep[]
}

// ── Expectations (§18.2) ──

export interface RunOutcomeExpectation {
  kind: RunOutcomeKind
  /** Deep-partial match on the outcome payload (e.g. { reason: "model_call_budget" }). */
  payload?: Record<string, unknown>
}

export interface EventExpectation {
  type: string
  count?: number
  minCount?: number
  absent?: boolean
  /** Deep-partial match on the event payload. */
  payload?: Record<string, unknown>
}

export interface ArtifactExpectation {
  minCount?: number
  exactCount?: number
}

export interface WorkspaceExpectation {
  files?: Array<{ path: string; mode: "exists" | "not_exists" | "equals" | "contains"; value?: string }>
  /** No files beyond initialWorkspace may be created. */
  noAdditionalFiles?: boolean
}

export interface BudgetExpectation {
  /** Exact assertions on used counters (modelCalls/toolCalls/writes/externalActions). */
  used?: Partial<BudgetUsage>
  exhausted?: boolean
  reason?: BudgetExhaustionReason
}

export interface InterruptResponseSpec {
  accepted: boolean
  payload?: unknown
  /** HR-011: the second resume must throw a HarnessError. */
  expectRefused?: boolean
  /** HR-012 hook: mutate the workspace before resuming. */
  mutateWorkspaceBeforeResume?: Record<string, string>
}

export interface RunReplayOptions {
  flashTriagePolicy?: "off" | "auto" | "always"
  contextMaxTokens?: number
  idleTimeoutMs?: number
  maxWallTimeMs?: number
}

export interface RunReplayCase {
  caseId: string
  title?: string
  description?: string
  tags?: string[]
  input: AgentRunInput
  initialWorkspace: Record<string, string>
  providerScript: ProviderScriptEvent[]
  toolScript?: ToolScriptResult[]
  interruptResponses?: InterruptResponseSpec[]
  options?: RunReplayOptions
  expected: {
    outcome: RunOutcomeExpectation
    events: EventExpectation[]
    artifacts: ArtifactExpectation[]
    workspace: WorkspaceExpectation
    budget?: BudgetExpectation
  }
}

export interface RunReplayResult {
  caseId: string
  passed: boolean
  failures: string[]
  events: Array<{ type: string; payload: unknown }>
  snapshot: {
    status: string
    outcome?: { kind: string; [key: string]: unknown }
    budgetState: unknown
    artifactRefs: unknown[]
  }
  durationMs: number
  workspaceDir: string
}

/** Structural validation of a case definition (fail-fast on bad scripts). */
export function validateRunReplayCase(caseDef: RunReplayCase): string[] {
  const issues: string[] = []
  if (!caseDef.caseId) issues.push("caseId required")
  if (!caseDef.input?.prompt) issues.push("input.prompt required")
  if (!Array.isArray(caseDef.providerScript) || caseDef.providerScript.length === 0) {
    issues.push("providerScript must be a non-empty array")
  }
  if (!caseDef.expected?.outcome?.kind) issues.push("expected.outcome.kind required")
  if (!caseDef.expected?.events) issues.push("expected.events required")
  if (!caseDef.expected?.workspace) issues.push("expected.workspace required")
  const rounds = caseDef.providerScript.filter((e) => e.type === "round_end").length
  if (rounds === 0) issues.push("providerScript must contain at least one round_end")
  return issues
}
