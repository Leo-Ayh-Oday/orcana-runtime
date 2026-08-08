/** LR2-3（P3-A）：WorkloadFingerprint + HistoricalResourceProfile。
 *
 *  可解释统计模型（计划 §7.1-3）：
 *  WorkloadFingerprint → HistoricalResourceProfile → Quantile Estimate
 *  → Reservation → Actual Usage → Calibration。
 *
 *  指纹不使用完整命令参数（样本碎片化）：tool kind / command family /
 *  repository class / file-count bucket / lockfile digest / test-count
 *  bucket / backend / profile / cache state / runtime family /
 *  previous failure class。
 *
 *  估算规则（"升得快、降得慢"，避免偶发低用量持续压低资源）：
 *  - 无历史 → 保守模板；
 *  - 少量历史 → max(default, observed max × safety)；
 *  - 稳定历史 → p90/p95 + safety margin；
 *  - 发生 OOM → 快速提高 memory estimate；
 *  - 连续稳定 → 缓慢降低 estimate。
 */

import { createHash } from "node:crypto"

export interface WorkloadFingerprint {
  toolKind: string
  commandFamily: string
  repositoryClass: string
  fileCountBucket: string
  lockfileDigest?: string
  testCountBucket?: string
  backend: string
  profile: string
  cacheState: string
  runtimeFamily: string
  previousFailureClass?: string
}

/** 指纹 → 稳定 digest（存储键）。 */
export function fingerprintOf(fp: WorkloadFingerprint): string {
  return createHash("sha256")
    .update(JSON.stringify(fp))
    .digest("hex")
    .slice(0, 16)
}

export interface ResourceSample {
  cpuUsec: number
  peakMemoryBytes: number
  wallTimeMs: number
  peakPids: number
  readBytes: number
  writeBytes: number
  failed: boolean
  oomKilled: boolean
  cacheHit: boolean
  at: number
}

export interface Quantiles {
  p50: number
  p90: number
  p95: number
  p99: number
}

function quantiles(values: number[]): Quantiles | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const idx = (p: number): number => Math.min(sorted.length - 1, Math.floor(sorted.length * p))
  return { p50: sorted[idx(0.5)]!, p90: sorted[idx(0.9)]!, p95: sorted[idx(0.95)]!, p99: sorted[idx(0.99)]! }
}

/** 滚动窗口样本（最多 KEEP_SAMPLES 个；聚合统计由分位数实时算）。 */
const KEEP_SAMPLES = 50

export class HistoricalResourceProfile {
  readonly fingerprint: WorkloadFingerprint
  samples: ResourceSample[] = []
  /** 连续稳定次数（用于慢降规则）。 */
  stableRounds = 0
  /** 最近一次 OOM 时间（OOM 快升规则）。 */
  lastOomAt = 0

  constructor(fingerprint: WorkloadFingerprint) {
    this.fingerprint = fingerprint
  }

  get sampleCount(): number {
    return this.samples.length
  }

  record(sample: ResourceSample): void {
    this.samples.push(sample)
    if (this.samples.length > KEEP_SAMPLES) this.samples.shift()
    if (sample.oomKilled) {
      this.lastOomAt = sample.at
      this.stableRounds = 0
    } else if (!sample.failed) {
      this.stableRounds += 1
    } else {
      this.stableRounds = 0
    }
  }

  private quantileOf(key: keyof Pick<ResourceSample, "cpuUsec" | "peakMemoryBytes" | "wallTimeMs" | "peakPids" | "readBytes" | "writeBytes">): Quantiles | undefined {
    return quantiles(this.samples.map(s => s[key]))
  }

  get failureRate(): number {
    if (this.samples.length === 0) return 0
    return this.samples.filter(s => s.failed).length / this.samples.length
  }

  get oomRate(): number {
    if (this.samples.length === 0) return 0
    return this.samples.filter(s => s.oomKilled).length / this.samples.length
  }

  get cacheHitRate(): number {
    if (this.samples.length === 0) return 0
    return this.samples.filter(s => s.cacheHit).length / this.samples.length
  }

  /** 估算资源（升得快降得慢）。 */
  estimate(input: {
    defaultMemoryBytes: number
    defaultWallTimeMs: number
    safetyFactor?: number
    now?: number
  }): { memoryBytes: number; wallTimeMs: number; basis: "template" | "observed" | "stabilized" } {
    const safety = input.safetyFactor ?? 1.3
    const now = input.now ?? Date.now()
    const memQ = this.quantileOf("peakMemoryBytes")
    const wallQ = this.quantileOf("wallTimeMs")

    // 无历史 → 保守模板
    if (!memQ || !wallQ) {
      return { memoryBytes: input.defaultMemoryBytes, wallTimeMs: input.defaultWallTimeMs, basis: "template" }
    }

    // OOM 快升：最近 OOM → 显著提高 memory（短期覆盖）
    if (this.lastOomAt > 0 && now - this.lastOomAt < 10 * 60_000) {
      return {
        memoryBytes: Math.max(memQ.p95 * 2, input.defaultMemoryBytes * 2),
        wallTimeMs: wallQ.p95,
        basis: "observed",
      }
    }

    // 少量历史（<5 样本）→ max(default, observed max × safety)
    if (this.samples.length < 5) {
      const observedMaxMem = Math.max(...this.samples.map(s => s.peakMemoryBytes))
      const observedMaxWall = Math.max(...this.samples.map(s => s.wallTimeMs))
      return {
        memoryBytes: Math.max(input.defaultMemoryBytes, observedMaxMem * safety),
        wallTimeMs: Math.max(input.defaultWallTimeMs, observedMaxWall * safety),
        basis: "observed",
      }
    }

    // 稳定历史 → p90/p95 + margin；连续稳定（≥20 轮无失败）→ 缓慢降低
    const rounds = this.stableRounds
    const reduction = rounds >= 20 ? 0.9 : 1.0
    return {
      memoryBytes: Math.max(input.defaultMemoryBytes, memQ.p90 * safety * reduction),
      wallTimeMs: Math.max(input.defaultWallTimeMs, wallQ.p95 * safety * reduction),
      basis: rounds >= 20 ? "stabilized" : "observed",
    }
  }

  /** 序列化（持久化）。 */
  toJSON(): string {
    return JSON.stringify({ fingerprint: this.fingerprint, samples: this.samples, stableRounds: this.stableRounds, lastOomAt: this.lastOomAt })
  }

  static fromJSON(json: string): HistoricalResourceProfile {
    const parsed = JSON.parse(json) as { fingerprint: WorkloadFingerprint; samples: ResourceSample[]; stableRounds: number; lastOomAt: number }
    const profile = new HistoricalResourceProfile(parsed.fingerprint)
    profile.samples = parsed.samples
    profile.stableRounds = parsed.stableRounds
    profile.lastOomAt = parsed.lastOomAt
    return profile
  }
}
