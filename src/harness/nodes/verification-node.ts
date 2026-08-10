/** VerificationNode (H11) — verification results ingested as artifacts.
 *
 *  Thin wrapper over the H8 evidence adapter: each VerificationResult becomes
 *  a bound artifact + evidence entry. H12: kernel round state rides in via
 *  input.kernelRoundState (write generation for evidence staleness + a
 *  producedBy attribution override) — the coordinator's Parts 2-4 (ripple
 *  phase, batch typecheck, self-edit gate) stay kernel-owned because they
 *  need the full AgentRunState; this node owns only the ingestion half.
 */

import type { HarnessNode, NodeEvent, NodeExecutionContext, NodeResult, NodeUsage, VerificationNodeInput } from "../contracts/nodes"
import { ingestVerificationWithArtifact } from "../artifacts/evidence-adapter"
import { computeRelevantFileHashes } from "../artifacts/freshness"
import { snapshotEvidence, diffEvidence } from "./context"

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

      // R1: evidence = entries this node ADDS; projectRoot is the run scope's
      // (relative modified files resolve against it, not the CLI cwd).
      const evidenceSnapshot = snapshotEvidence(context.runScope.evidenceLedger)
      const relevantFileHashes = input.modifiedFiles?.length
        ? computeRelevantFileHashes(context.runScope.projectRoot, input.modifiedFiles)
        : undefined

      try {
        for (const result of input.results) {
          const pair = await ingestVerificationWithArtifact({
            store: context.artifacts,
            ledger: context.runScope.evidenceLedger,
            runId: context.runId,
            result,
            // H12: kernel round attribution when the workflow carries it —
            // the round's write generation makes the evidence entry's
            // staleness field meaningful; producedBy identifies the round's
            // verifier instead of the node id.
            producedBy: input.kernelRoundState?.producedBy ?? options.id,
            generation: input.kernelRoundState?.generation,
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

        // R1: the ingested entries ARE this node's evidence (ledger diff).
        const newEvidence = diffEvidence(context.runScope.evidenceLedger, evidenceSnapshot)
        result = {
          status: "succeeded",
          output: { ingested, passedCount, failedCount },
          evidence: newEvidence,
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
