/** LR2-6（P6-C）：性能回归评估 —— 阈值取自基线快照，不硬编码。
 *
 *  延续 LR2-2"先基线后阈值"原则：基线先跑一轮产生 p50/p95 基线，
 *  候选与之对比。允许的退化比例由清单 promotionCriteria
 *  （maxPerfRegressionRatio）决定。
 */

export interface PerfSample {
  /** 基准名（如 warm-start / replay-throughput）。 */
  benchName: string
  /** 该基准的单次采样（毫秒或 ops —— 数值越小越好）。 */
  valueMs: number
}

export interface PerfBaselineSnapshot {
  benchName: string
  p50Ms: number
  p95Ms: number
  sampleCount: number
  source: string
  evaluatedAt: string
}

export type PerfVerdict =
  | { ok: true; reason: string }
  | { ok: false; reason: string; regressed: Array<{ benchName: string; baselineP95Ms: number; candidateP95Ms: number; ratio: number }> }

export interface PerfRegressionOptions {
  /** 允许的最大退化比例（相对基线 p95）。来自清单 criteria。 */
  maxRegressionRatio: number
}

/** 从采样计算基线快照（p50/p95）。 */
export function computePerfBaseline(benchName: string, samplesMs: number[], source = "baseline-run"): PerfBaselineSnapshot {
  if (samplesMs.length === 0) throw new Error(`perf baseline requires samples: ${benchName}`)
  const sorted = [...samplesMs].sort((a, b) => a - b)
  const pct = (p: number) => {
    const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length))
    return sorted[idx]!
  }
  return {
    benchName,
    p50Ms: pct(0.5),
    p95Ms: pct(0.95),
    sampleCount: samplesMs.length,
    source,
    evaluatedAt: new Date().toISOString(),
  }
}

/** 候选采样 → p95 对比基线（阈值来自基线，不硬编码数字）。 */
export function comparePerfBaselines(
  baselines: PerfBaselineSnapshot[],
  candidateSamples: PerfSample[],
  opts: PerfRegressionOptions,
): PerfVerdict {
  if (opts.maxRegressionRatio < 0 || opts.maxRegressionRatio > 1) {
    throw new Error("maxRegressionRatio must be in [0,1]")
  }
  const byName = new Map(baselines.map(b => [b.benchName, b]))
  const candidateByName = new Map<string, number[]>()
  for (const s of candidateSamples) {
    const arr = candidateByName.get(s.benchName) ?? []
    arr.push(s.valueMs)
    candidateByName.set(s.benchName, arr)
  }
  const regressed: Array<{ benchName: string; baselineP95Ms: number; candidateP95Ms: number; ratio: number }> = []

  for (const [name, samples] of candidateByName) {
    const base = byName.get(name)
    if (!base) continue // 候选新增基准不判定回归（也不隐藏）
    const sorted = [...samples].sort((a, b) => a - b)
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))]!
    const ratio = base.p95Ms > 0 ? p95 / base.p95Ms : 1
    if (ratio > 1 + opts.maxRegressionRatio) {
      regressed.push({ benchName: name, baselineP95Ms: base.p95Ms, candidateP95Ms: p95, ratio })
    }
  }

  if (regressed.length > 0) {
    return {
      ok: false,
      reason: `perf regression: ${regressed.map(r => `${r.benchName} p95 ${r.baselineP95Ms.toFixed(1)}→${r.candidateP95Ms.toFixed(1)}ms (x${r.ratio.toFixed(2)})`).join(", ")}`,
      regressed,
    }
  }
  return { ok: true, reason: "performance within baseline thresholds" }
}
