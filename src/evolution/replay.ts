/** LR2-6（P6-B）：Replay —— 基线/候选在同一不可变清单下重放。
 *
 *  两种后端产出同一 ReplayResult 形状：
 *  1. 函数评测（纯函数引用 —— 本机无双版本代码库时的主路径）；
 *  2. execd Cell 执行（有 cgroup 时可接真实沙箱）。
 */

import type { EvolutionManifest, ReplayCaseRef } from "./manifest"
import { assertEnvironmentMatchesManifest, computeEnvironmentDigest, type EnvironmentFacts } from "./digest"

export type ReplayOutcome = "passed" | "failed" | "errored" | "skipped"

export interface ReplayCaseResult {
  caseId: string
  inputDigest: string
  outcome: ReplayOutcome
  /** 失败/错误原因（通过时为 undefined）。 */
  detail?: string
  /** 原始输出摘要（大对象不在此处 —— 只存摘要）。 */
  outputDigest?: string
  /** 墙钟耗时（毫秒）。 */
  durationMs: number
  /** 执行环境摘要（= 该侧的实际环境）。 */
  environmentDigest: string
}

export interface ReplayRun {
  side: "baseline" | "candidate"
  manifestId: string
  /** 该侧引用的提交/版本。 */
  sourceRef: string
  results: ReplayCaseResult[]
  startedAt: string
}

/** 重放函数签名：给定 case + 该侧实现引用，返回该 case 的观测。 */
export type ReplayExecutor = (
  caseRef: ReplayCaseRef,
  side: "baseline" | "candidate",
  sourceRef: string,
) => Promise<ReplayCaseResult>

export interface ReplayOptions {
  executor: ReplayExecutor
  /** 严格环境：候选环境必须与清单声明一致（默认 true）。 */
  requireEnvironmentMatch?: boolean
  /** 候选侧允许差异的环境字段（默认仅 sourceDigest —— 候选自身的提交）。 */
  allowCandidateEnvironmentDiff?: Array<keyof EnvironmentFacts>
  manifest: EvolutionManifest
  baselineSourceRef: string
  candidateSourceRef: string
  candidateEnvironment?: EnvironmentFacts
}

/** 重放两遍：基线 + 候选。环境漂移未声明时直接拒绝。 */
export async function runReplay(opts: ReplayOptions): Promise<{ baseline: ReplayRun; candidate: ReplayRun }> {
  const requireMatch = opts.requireEnvironmentMatch ?? true
  if (requireMatch && opts.candidateEnvironment) {
    const check = assertEnvironmentMatchesManifest(opts.manifest.environmentDigest, opts.candidateEnvironment)
    if (!check.ok) throw new Error(`candidate environment drift: ${check.reason}`)
  }
  const startedAt = new Date().toISOString()
  const baselineResults: ReplayCaseResult[] = []
  const candidateResults: ReplayCaseResult[] = []
  for (const caseRef of opts.manifest.benchmarkSet) {
    baselineResults.push(await opts.executor(caseRef, "baseline", opts.baselineSourceRef))
    candidateResults.push(await opts.executor(caseRef, "candidate", opts.candidateSourceRef))
  }
  return {
    baseline: { side: "baseline", manifestId: opts.manifest.manifestId, sourceRef: opts.baselineSourceRef, results: baselineResults, startedAt },
    candidate: { side: "candidate", manifestId: opts.manifest.manifestId, sourceRef: opts.candidateSourceRef, results: candidateResults, startedAt },
  }
}

/** 基线参考结果（promotion 时重新生成基线环境的摘要对比）。 */
export function environmentDigestOf(facts: EnvironmentFacts): string {
  return computeEnvironmentDigest(facts)
}
