/** LR2-6（P6-A）：Environment Digest —— 统一环境摘要。
 *
 *  候选版本不得控制评测环境：基线/候选环境必须可摘要对比，任何漂移
 *  （drift）都必须在重放前拒绝（ENVIRONMENT_DRIFT_UNDETECTED = 0）。
 *  复用 receipt.ts 的 canonical JSON 语义（递归稳定排序 + 完整 SHA-256）。
 */

import { digestOf, canonicalJson, CANONICALIZATION_VERSION } from "../runtime/linux/receipt"

export const ENVIRONMENT_DIGEST_SCHEMA_VERSION = "1.0"

export interface EnvironmentFacts {
  /** 源码摘要（候选/基线各自的提交或目录摘要）。 */
  sourceDigest: string
  /** lockfile（bun.lock / package-lock 等）摘要。 */
  lockfileDigest?: string
  /** 工具链摘要（node/bun/rustc 版本等）。 */
  toolchainDigest?: string
  /** RootFS / OCI image 摘要（有容器化评测时）。 */
  rootfsDigest?: string
  /** 内核能力摘要（uname / 能力探测结果）。 */
  kernelCapabilityDigest?: string
  /** CellSpec 策略摘要（复用 computePolicyDigest 语义字段）。 */
  cellSpecDigest?: string
  /** 网络策略摘要。 */
  networkPolicyDigest?: string
  /** 资源策略摘要。 */
  resourcePolicyDigest?: string
  /** 评测器版本（评测器变化 = 不允许晋升）。 */
  evaluatorVersion: string
  /** 评测清单摘要（manifestId）。 */
  benchmarkManifestDigest: string
}

/** 计算环境摘要（全部字段进入 canonical JSON + SHA-256）。 */
export function computeEnvironmentDigest(facts: EnvironmentFacts): string {
  return digestOf({
    schemaVersion: ENVIRONMENT_DIGEST_SCHEMA_VERSION,
    canonicalizationVersion: CANONICALIZATION_VERSION,
    ...facts,
  })
}

/** 环境漂移检测：两份环境事实摘要是否一致（除允许差异字段）。
 *  双向对比 —— 候选独有键（基线没有的字段）也算漂移。 */
export function environmentDrift(
  baseline: EnvironmentFacts,
  candidate: EnvironmentFacts,
  opts: { allowFields?: Array<keyof EnvironmentFacts> } = {},
): { drift: boolean; differingFields: Array<keyof EnvironmentFacts> } {
  const allow = new Set(opts.allowFields ?? [])
  const differing: Array<keyof EnvironmentFacts> = []
  const keys = new Set([...Object.keys(baseline), ...Object.keys(candidate)] as Array<keyof EnvironmentFacts>)
  for (const key of keys) {
    if (allow.has(key)) continue
    if (baseline[key] !== candidate[key]) differing.push(key)
  }
  return { drift: differing.length > 0, differingFields: differing }
}

/** 从一组可观察事实构造 EnvironmentFacts（缺失字段不填 → 摘要不含）。 */
export function buildEnvironmentFacts(partial: Partial<EnvironmentFacts> & Pick<EnvironmentFacts, "evaluatorVersion" | "benchmarkManifestDigest" | "sourceDigest">): EnvironmentFacts {
  const required = ["sourceDigest", "evaluatorVersion", "benchmarkManifestDigest"] as const
  for (const k of required) {
    if (partial[k] === undefined || partial[k] === "") {
      throw new Error(`environment facts missing required field: ${k}`)
    }
  }
  return {
    sourceDigest: partial.sourceDigest,
    lockfileDigest: partial.lockfileDigest,
    toolchainDigest: partial.toolchainDigest,
    rootfsDigest: partial.rootfsDigest,
    kernelCapabilityDigest: partial.kernelCapabilityDigest,
    cellSpecDigest: partial.cellSpecDigest,
    networkPolicyDigest: partial.networkPolicyDigest,
    resourcePolicyDigest: partial.resourcePolicyDigest,
    evaluatorVersion: partial.evaluatorVersion,
    benchmarkManifestDigest: partial.benchmarkManifestDigest,
  }
}

/** 摘要一致性校验（候选环境与清单声明的环境必须一致）。 */
export function assertEnvironmentMatchesManifest(manifestEnvDigest: string, facts: EnvironmentFacts): { ok: boolean; reason?: string } {
  const actual = computeEnvironmentDigest(facts)
  if (actual !== manifestEnvDigest) {
    return { ok: false, reason: `environment digest mismatch: manifest=${manifestEnvDigest} actual=${actual}` }
  }
  return { ok: true }
}

export { canonicalJson }
