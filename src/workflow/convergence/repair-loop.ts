/** Convergent Repair Loop (G4): provably convergent fix loop.
 *
 *  Built on the G3 single-writer transaction graph: each round executes a
 *  repair spec, fingerprints failures, and converges via seen/confirmed
 *  separation, dry-round detection and hard attempt/budget bounds.
 *  Kernel untouched — the loop is a pure workflow-layer capability.
 *
 *  Termination guarantees:
 *   - same signature never re-executes the same failed fix (dedupe)
 *   - maxAttempts hard cap
 *   - two consecutive dry rounds (no new signature, no metric gain) → "dry"
 *   - budget exhaustion → structured "budget_exhausted" report
 */

import type { WorkflowSpec, WorkflowRunResult, WorkflowNodeResult } from "../types"
import type { HandlerRegistry } from "../execution/handler-registry"
import { runScheduler } from "../scheduler/scheduler"
import { fingerprintFailure } from "./failure-signature"
import type { RetryLedger } from "../../runtime/retry-ledger"

/** Verification producers (G3 whitelist) — their failures surface as
 *  not-passed evidence / blocked_no_evidence, not as repair signatures. */
const VERIFICATION_HANDLERS = new Set(["tool.run_targeted_verification"])

export type RepairOutcome = "done" | "dry" | "max_attempts" | "budget_exhausted"

export interface RepairLoopOptions {
  registry: HandlerRegistry
  /** Builds the repair spec for the next round; may return null when no
   *  new fix strategy remains (counts as a dry round). */
  specFactory: (ctx: {
    round: number
    seen: Set<string>
    confirmed: Array<{ nodeId: string; evidenceCount: number }>
  }) => WorkflowSpec | null
  maxAttempts?: number
  maxDryRounds?: number
  /** Round budget (inclusive); exceeding it → budget_exhausted. */
  budget?: number
  /** RC-19 D7: tool path authority root threaded into each scheduler run. */
  projectRoot?: string
  checkpointDir?: string
  /** PR-GATE-06：Run 级 RetryLedger —— 同一失败签名（semanticRepair 类，
   *  <= 2）经统一账本限次，与 provider/capability 层共享预算。 */
  retryLedger?: RetryLedger
  /**
   * IC04 §42: Run 级 RetryCoordinator —— 同一 failure signature 是否允许
   * 再进入 repair 的唯一 authorization 来源（替代直接 retryLedger 调用）。
   */
  retryCoordinator?: import("../../runtime/retry/coordinator").RetryCoordinator
}

export interface RepairAttempt {
  round: number
  /** null when the factory produced no new fix strategy (dry round). */
  run: WorkflowRunResult | null
  newSignatures: string[]
  dry: boolean
}

export interface ConvergenceReport {
  outcome: RepairOutcome
  attempts: number
  dryRounds: number
  seen: string[]
  confirmed: Array<{ nodeId: string; evidenceCount: number }>
  blocked: Array<{ nodeId: string; signature: string; attempts: number }>
  rounds: RepairAttempt[]
}

export class RepairLoop {
  private readonly registry: HandlerRegistry
  private readonly specFactory: RepairLoopOptions["specFactory"]
  private readonly maxAttempts: number
  private readonly maxDryRounds: number
  private readonly budget?: number
  private readonly checkpointDir?: string
  private readonly projectRoot?: string
  private readonly retryLedger?: RetryLedger
  private readonly retryCoordinator?: import("../../runtime/retry/coordinator").RetryCoordinator

  constructor(options: RepairLoopOptions) {
    this.registry = options.registry
    this.specFactory = options.specFactory
    this.maxAttempts = options.maxAttempts ?? 3
    this.maxDryRounds = options.maxDryRounds ?? 2
    this.budget = options.budget
    this.checkpointDir = options.checkpointDir
    this.projectRoot = options.projectRoot
    this.retryLedger = options.retryLedger
    this.retryCoordinator = options.retryCoordinator
  }

  async run(): Promise<ConvergenceReport> {
    const seen = new Set<string>()
    const confirmed: Array<{ nodeId: string; evidenceCount: number }> = []
    const nodeAttempts = new Map<string, number>()
    const rounds: RepairAttempt[] = []
    let dryRounds = 0
    let prevPassed = -1
    let prevWriteFailed = Number.MAX_SAFE_INTEGER

    for (let round = 1; round <= this.maxAttempts; round++) {
      if (this.budget !== undefined && round > this.budget) {
        return this.finalize("budget_exhausted", round - 1, dryRounds, seen, confirmed, nodeAttempts, rounds)
      }

      const spec = this.specFactory({ round, seen, confirmed })
      if (!spec) {
        dryRounds++
        rounds.push({ round, run: null, newSignatures: [], dry: true })
        if (dryRounds >= this.maxDryRounds) {
          return this.finalize("dry", round, dryRounds, seen, confirmed, nodeAttempts, rounds)
        }
        continue
      }

      const run = await runScheduler(spec, this.registry, { checkpointDir: this.checkpointDir, projectRoot: this.projectRoot })

      const handlerOf = new Map(spec.nodes.map(n => [n.id, n.handler]))
      const failed = run.results.filter(r => r.status === "failed")
      const newSignatures: string[] = []
      let writeFailed = 0
      for (const result of failed) {
        if (VERIFICATION_HANDLERS.has(handlerOf.get(result.nodeId) ?? "")) continue
        writeFailed++
        const sig = fingerprintFailure(result)
        nodeAttempts.set(result.nodeId, (nodeAttempts.get(result.nodeId) ?? 0) + 1)
        // PR-GATE-06 + IC04 §42：同一失败签名经 RetryCoordinator 授权
        // （semanticRepair <= 2）—— 超限的签名不再驱动新的修复轮（不加入
        // seen），该 node 计入 blocked；换策略或停止由 specFactory/dry
        // 检测接管。coordinator 优先；legacy retryLedger 保留兼容。
        if (this.retryCoordinator) {
          const permit = this.retryCoordinator.authorizeRetry({ retryClass: "semanticRepair", fingerprint: sig })
          if (!permit.allowed) continue
        } else if (this.retryLedger) {
          if (!this.retryLedger.canRetry("semanticRepair", sig)) continue
          this.retryLedger.record("semanticRepair", sig)
        }
        if (!seen.has(sig)) {
          seen.add(sig)
          newSignatures.push(sig)
        }
      }

      const passed = run.evidence?.filter(e => e.passed).length ?? 0
      // Metric gain: more passing evidence, or fewer failing write nodes.
      const metricGain = passed > prevPassed || writeFailed < prevWriteFailed
      prevPassed = passed
      prevWriteFailed = writeFailed

      const dry = newSignatures.length === 0 && !metricGain
      dryRounds = metricGain ? 0 : dry ? dryRounds + 1 : 0
      rounds.push({ round, run, newSignatures, dry })

      if (run.status === "done") {
        const evidence = run.evidence ?? []
        for (const entry of evidence.filter(e => e.passed)) {
          const writeNodeId = entry.writeNodeIds[0] ?? entry.nodeId
          if (!confirmed.some(c => c.nodeId === writeNodeId)) {
            confirmed.push({ nodeId: writeNodeId, evidenceCount: 1 })
          }
        }
        return this.finalize("done", round, dryRounds, seen, confirmed, nodeAttempts, rounds)
      }

      if (dryRounds >= this.maxDryRounds) {
        return this.finalize("dry", round, dryRounds, seen, confirmed, nodeAttempts, rounds)
      }
    }

    return this.finalize("max_attempts", this.maxAttempts, dryRounds, seen, confirmed, nodeAttempts, rounds)
  }

  private finalize(
    outcome: RepairOutcome,
    attempts: number,
    dryRounds: number,
    seen: Set<string>,
    confirmed: Array<{ nodeId: string; evidenceCount: number }>,
    nodeAttempts: Map<string, number>,
    rounds: RepairAttempt[],
  ): ConvergenceReport {
    const confirmedIds = new Set(confirmed.map(c => c.nodeId))
    const blocked = [...nodeAttempts.entries()]
      .filter(([nodeId]) => !confirmedIds.has(nodeId))
      .map(([nodeId, attempts]) => ({
        nodeId,
        signature: [...seen.values()].find(s => s.startsWith(`${nodeId}|`)) ?? `${nodeId}|unclassified`,
        attempts,
      }))
    return { outcome, attempts, dryRounds, seen: [...seen], confirmed, blocked, rounds }
  }
}
