/** VerificationNode (H11) — verification results ingested as artifacts.
 *
 *  Thin wrapper over the H8 evidence adapter: each VerificationResult becomes
 *  a bound artifact + evidence entry. Deliberately does NOT re-implement
 *  bindVerificationToLedger (which needs the kernel's full round
 *  VerificationContext) — wiring that for workflow nodes carrying kernel
 *  round state is deferred to H12.
 */

import type { HarnessNode, NodeEvent, NodeExecutionContext, NodeResult, NodeUsage, VerificationNodeInput } from "../contracts/nodes"
import { ingestVerificationWithArtifact } from "../artifacts/evidence-adapter"
import { computeRelevantFileHashes } from "../artifacts/freshness"

export interface VerificationNodeOutput {
  ingested: Array<{ artifactId: string; evidenceId: string }>
  passedCount: number
  failedCount: number
}

export function createVerificationNode(options: { id: string }): HarnessNode<VerificationNodeInput, VerificationNodeOutput> {
  let result: NodeResult<VerificationNodeOutput> | null = null

  return {
    id: options.id,
    kind: "verification",

    async *execute(context: NodeExecutionContext, input: VerificationNodeInput): AsyncGenerator<NodeEvent> {
      const ingested: Array<{ artifactId: string; evidenceId: string }> = []
      let passedCount = 0
      let failedCount = 0
      const warnings: Array<{ code: string; message: string }> = []

      const relevantFileHashes = input.modifiedFiles?.length
        ? computeRelevantFileHashes(process.cwd(), input.modifiedFiles)
        : undefined

      try {
        for (const result of input.results) {
          const pair = await ingestVerificationWithArtifact({
            store: context.artifacts,
            ledger: context.runScope.evidenceLedger,
            runId: context.runId,
            result,
            producedBy: options.id,
            workspaceHash: input.workspaceHash,
            relevantFileHashes,
          })
          if (!pair) {
            warnings.push({ code: "unclassified_kind", message: `verification kind ${result.kind} not artifact-classifiable` })
            continue
          }
          ingested.push({ artifactId: pair.artifact.artifactId, evidenceId: pair.entry.id })
          if (result.passed) passedCount += 1
          else failedCount += 1
          yield { type: "node.artifact", nodeRunId: context.nodeRunId, artifactId: pair.artifact.artifactId }
        }

        result = {
          status: "succeeded",
          output: { ingested, passedCount, failedCount },
          evidence: [],
          diagnostics: warnings.map((w) => ({ code: w.code, message: w.message, severity: "warning" as const, source: options.id })),
          usage: zeroUsage(),
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const nodeError: NodeResult<VerificationNodeOutput>["error"] = { kind: "verification_ingest_failed", message, retryable: false }
        result = {
          status: "failed",
          evidence: [],
          diagnostics: [{ code: "verification_ingest_failed", message, severity: "error", source: options.id }],
          usage: zeroUsage(),
          error: nodeError,
        }
        yield { type: "node.error", nodeRunId: context.nodeRunId, error: nodeError }
      }
    },

    async getResult(): Promise<NodeResult<VerificationNodeOutput>> {
      if (!result) throw new Error(`node ${options.id} getResult called before execute`)
      return result
    },
  }
}

function zeroUsage(): NodeUsage {
  return { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cacheMissTokens: 0, wallTimeMs: 0 }
}
