/** Tool Runtime 2.0 (RT-1): structured tool execution result.
 *
 *  `domain_failed` vs `execution_failed` distinction (plan §4.3):
 *    - domain_failed  → the tool ran, the task domain said NO (typecheck
 *      failed, tests failed, verification failed) — a meaningful answer.
 *    - execution_failed → the tool could not run at all (process crashed,
 *      schema rejected the input, environment missing).
 *  Fail-closed: a result that produced neither structuredContent nor an
 *  error is an invalid state by construction.
 */

import type { ToolErrorInfo } from "./errors"

export type ToolExecutionStatus =
  | "succeeded"
  | "domain_failed"
  | "execution_failed"
  | "blocked"
  | "cancelled"
  | "timed_out"

export interface ArtifactReference {
  artifactId: string
  contentRef: string
  kind: string
  /** Hash of the stored content (provenance). */
  contentHash: string
}

export interface EvidenceReference {
  evidenceId: string
  kind: "typecheck" | "test" | "build" | "manual"
  /** The claim this evidence supports (e.g. "typecheck_passed"). */
  claim: string
}

export interface Diagnostic {
  severity: "info" | "warning" | "error"
  code?: string
  message: string
  /** File-relative path when the diagnostic anchors to a file. */
  file?: string
  line?: number
  column?: number
}

export interface ToolExecutionMetrics {
  startedAt: number
  durationMs: number
  outputBytes: number
}

export interface ToolExecutionResult<O = unknown> {
  status: ToolExecutionStatus
  /** Structured output — present iff status is succeeded/domain_failed. */
  structuredContent?: O
  /** Human-readable rendition for the model display path. */
  displayContent?: string
  error?: ToolErrorInfo
  artifacts: ArtifactReference[]
  evidence: EvidenceReference[]
  diagnostics: Diagnostic[]
  metrics: ToolExecutionMetrics
}

export interface ToolExecutionResultInput<O> {
  status?: ToolExecutionStatus
  structuredContent?: O
  displayContent?: string
  error?: ToolErrorInfo
  artifacts?: ArtifactReference[]
  evidence?: EvidenceReference[]
  diagnostics?: Diagnostic[]
  startedAt?: number
}

/** Build a result with sensible defaults; `startedAt` is supplied by the
 *  caller so durationMs is accurate (executor stamps it). */
export function toolResult<O>(input: ToolExecutionResultInput<O>, startedAt = Date.now()): ToolExecutionResult<O> {
  return {
    status: input.status ?? "succeeded",
    structuredContent: input.structuredContent,
    displayContent: input.displayContent,
    error: input.error,
    artifacts: input.artifacts ?? [],
    evidence: input.evidence ?? [],
    diagnostics: input.diagnostics ?? [],
    metrics: {
      startedAt,
      durationMs: Date.now() - startedAt,
      outputBytes: (input.displayContent?.length ?? 0) + (input.structuredContent === undefined ? 0 : estimateBytes(input.structuredContent)),
    },
  }
}

function estimateBytes(value: unknown): number {
  try {
    return JSON.stringify(value).length
  } catch {
    return 0
  }
}

/** Convenience constructors for the six statuses (fail-closed shapes). */
export const resultHelpers = {
  ok<O>(structuredContent: O, displayContent?: string, extra: Partial<ToolExecutionResultInput<O>> = {}) {
    return toolResult({ status: "succeeded", structuredContent, displayContent, ...extra })
  },
  domainFailed<O>(structuredContent: O, displayContent: string, diagnostics: Diagnostic[] = []) {
    return toolResult({ status: "domain_failed", structuredContent, displayContent, diagnostics })
  },
  executionFailed(error: ToolErrorInfo, displayContent?: string) {
    return toolResult({ status: "execution_failed", error, displayContent })
  },
  blocked(error: ToolErrorInfo, displayContent?: string) {
    return toolResult({ status: "blocked", error, displayContent })
  },
  cancelled(displayContent = "cancelled") {
    return toolResult({ status: "cancelled", displayContent })
  },
  timedOut(displayContent = "timed out") {
    return toolResult({ status: "timed_out", displayContent })
  },
}
