/** LR2-6（P6-A）：EvolutionManifest —— 不可变评测清单。
 *
 *  候选版本不得控制：测试集 / 评分器 / 基线版本 / 环境构造 / 失败样本 /
 *  晋升条件 / 回滚条件。清单内容寻址 —— 任何字段变更产生新 manifestId；
 *  评测器版本变化同样导致新 id（EVALUATOR_CHANGED 拒绝晋升）。
 */

import { digestOf, canonicalJson, CANONICALIZATION_VERSION } from "../runtime/linux/receipt"
import { computeEnvironmentDigest, type EnvironmentFacts } from "./digest"

export const MANIFEST_SCHEMA_VERSION = "1.0"

/** 单个评测用例（不可变输入引用）。 */
export interface ReplayCaseRef {
  id: string
  /** 用例输入的内容摘要（不可变）。 */
  inputDigest: string
  /** 用例名称（仅展示，不参与摘要）。 */
  name?: string
}

/** 评分器契约：候选不得修改 —— 摘要进 manifestId。 */
export interface ScorerContract {
  /** 评分器实现摘要（算法版本）。 */
  scorerDigest: string
  /** 正确性规则摘要（如通过标准）。 */
  correctnessRulesDigest: string
}

/** 晋升要求快照（随清单冻结）。 */
export interface PromotionCriteria {
  /** 正确性不下降：回归数必须为 0。 */
  requireZeroRegression: boolean
  /** 安全 Gate 不下降。 */
  requireSecurityGateNonRegression: boolean
  /** 性能阈值：相对基线允许的最大退化比例（0.1 = 10%）。 */
  maxPerfRegressionRatio: number
  /** 失败样本未减少或隐藏：失败→失败 且 有改进潜力时必须改善。 */
  requireNoHiddenFailure: boolean
  /** Canary 窗口（毫秒）内无新回归。 */
  canaryWatchWindowMs: number
}

export interface EvolutionManifestInput {
  benchmarkSet: ReplayCaseRef[]
  scorer: ScorerContract
  environment: EnvironmentFacts
  promotionCriteria: PromotionCriteria
  /** 基线版本引用（baseline commit / 版本号）。 */
  baselineRef: string
  evaluatorVersion: string
}

export interface EvolutionManifest {
  manifestId: string
  schemaVersion: string
  canonicalizationVersion: string
  benchmarkSet: ReplayCaseRef[]
  scorer: ScorerContract
  environment: EnvironmentFacts
  environmentDigest: string
  promotionCriteria: PromotionCriteria
  baselineRef: string
  evaluatorVersion: string
}

/** 校验清单输入（缺字段/空评测集/非法阈值 → 拒绝）。 */
export function validateManifestInput(input: EvolutionManifestInput): { ok: true; manifest: EvolutionManifest } | { ok: false; errors: string[] } {
  const errors: string[] = []
  if (!Array.isArray(input.benchmarkSet) || input.benchmarkSet.length === 0) {
    errors.push("benchmarkSet must be non-empty")
  } else {
    const seen = new Set<string>()
    for (const c of input.benchmarkSet) {
      if (!c.id || !c.inputDigest) errors.push(`case missing id/inputDigest: ${JSON.stringify(c)}`)
      if (seen.has(c.id)) errors.push(`duplicate case id: ${c.id}`)
      seen.add(c.id)
      if (c.inputDigest.length !== 64) errors.push(`case inputDigest must be full sha256 (64 hex): ${c.id}`)
    }
  }
  if (!input.scorer?.scorerDigest || !input.scorer?.correctnessRulesDigest) {
    errors.push("scorer contract missing scorerDigest/correctnessRulesDigest")
  }
  // M2：environment 必填 + 字段类型校验（候选不得控制环境构造）。
  const env = input.environment
  if (!env || typeof env !== "object") {
    errors.push("environment facts required")
  } else {
    const envErrors: string[] = []
    // 摘要类字段必须 64 hex
    const digestEnv: Array<keyof EnvironmentFacts> = ["sourceDigest", "lockfileDigest", "toolchainDigest", "rootfsDigest", "kernelCapabilityDigest", "cellSpecDigest", "networkPolicyDigest", "resourcePolicyDigest", "benchmarkManifestDigest"]
    for (const k of digestEnv) {
      const v = env[k]
      if (v !== undefined && (typeof v !== "string" || v.length !== 64)) envErrors.push(`environment.${k} must be full sha256 (64 hex)`)
    }
    if (env.sourceDigest === undefined) envErrors.push("environment.sourceDigest must be a non-empty string")
    if (env.benchmarkManifestDigest === undefined) envErrors.push("environment.benchmarkManifestDigest must be a non-empty string")
    // 版本类字段必须非空字符串
    if (typeof env.evaluatorVersion !== "string" || env.evaluatorVersion.length === 0) {
      envErrors.push("environment.evaluatorVersion must be a non-empty string")
    }
    if (envErrors.length > 0) errors.push(...envErrors)
  }
  if (!input.baselineRef) errors.push("baselineRef required")
  if (!input.evaluatorVersion) errors.push("evaluatorVersion required")
  const crit = input.promotionCriteria
  if (!crit || typeof crit.maxPerfRegressionRatio !== "number" || crit.maxPerfRegressionRatio < 0 || crit.maxPerfRegressionRatio > 1) {
    errors.push("promotionCriteria.maxPerfRegressionRatio must be in [0,1]")
  }
  if (!crit || typeof crit.canaryWatchWindowMs !== "number" || crit.canaryWatchWindowMs < 0) {
    errors.push("promotionCriteria.canaryWatchWindowMs must be >= 0")
  }
  // M2：criteria 布尔字段类型校验（字符串 "false" 为 truthy 会静默改变晋升语义）。
  if (crit) {
    for (const k of ["requireZeroRegression", "requireSecurityGateNonRegression", "requireNoHiddenFailure"] as const) {
      if (typeof crit[k] !== "boolean") errors.push(`promotionCriteria.${k} must be a boolean`)
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, manifest: buildManifest(input) }
}

function buildManifest(input: EvolutionManifestInput): EvolutionManifest {
  const base = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    canonicalizationVersion: CANONICALIZATION_VERSION,
    benchmarkSet: input.benchmarkSet,
    scorer: input.scorer,
    environment: input.environment,
    environmentDigest: computeEnvironmentDigest(input.environment),
    promotionCriteria: input.promotionCriteria,
    baselineRef: input.baselineRef,
    evaluatorVersion: input.evaluatorVersion,
  }
  return { ...base, manifestId: digestOf(base) }
}

/** 内容寻址幂等：同输入 → 同 manifestId。
 *  M3：environmentDigest 由 environment 派生 —— 与持久化字段一致性由
 *  parseManifest 强制（见下）。 */
export function manifestIdOf(input: EvolutionManifestInput): string {
  return digestOf({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    canonicalizationVersion: CANONICALIZATION_VERSION,
    benchmarkSet: input.benchmarkSet,
    scorer: input.scorer,
    environment: input.environment,
    environmentDigest: computeEnvironmentDigest(input.environment),
    promotionCriteria: input.promotionCriteria,
    baselineRef: input.baselineRef,
    evaluatorVersion: input.evaluatorVersion,
  })
}

/** 从持久化 JSON 恢复并校验完整性（id 必须与内容一致）。 */
export function parseManifest(json: string): { ok: true; manifest: EvolutionManifest } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(json) as EvolutionManifest
    const validation = validateManifestInput({
      benchmarkSet: parsed.benchmarkSet,
      scorer: parsed.scorer,
      environment: parsed.environment,
      promotionCriteria: parsed.promotionCriteria,
      baselineRef: parsed.baselineRef,
      evaluatorVersion: parsed.evaluatorVersion,
    })
    if (!validation.ok) return { ok: false, error: `invalid manifest: ${validation.errors.join("; ")}` }
    // M3：持久化 environmentDigest 必须与 environment facts 重算一致
    // （该字段是 runReplay 漂移判定的消费字段 —— 篡改它等于绕过清单契约）。
    if (parsed.environmentDigest !== computeEnvironmentDigest(parsed.environment)) {
      return { ok: false, error: "environmentDigest does not match environment facts" }
    }
    if (parsed.manifestId !== manifestIdOf({
      benchmarkSet: parsed.benchmarkSet,
      scorer: parsed.scorer,
      environment: parsed.environment,
      promotionCriteria: parsed.promotionCriteria,
      baselineRef: parsed.baselineRef,
      evaluatorVersion: parsed.evaluatorVersion,
    })) {
      return { ok: false, error: "manifestId does not match content (immutability violated)" }
    }
    return { ok: true, manifest: parsed }
  } catch (error) {
    return { ok: false, error: `malformed manifest: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 规范化序列化（持久化用）。 */
export function serializeManifest(manifest: EvolutionManifest): string {
  return canonicalJson(manifest)
}
