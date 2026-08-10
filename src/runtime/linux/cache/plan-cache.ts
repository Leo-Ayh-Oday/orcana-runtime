/** LR2-2（P2-A）：Sandbox Plan Cache —— 编译产物缓存。
 *
 *  缓存对象 CompiledSandboxPlan（计划 §6.1）：
 *  profileDigest / toolContractDigest / runtimeVersion / platform /
 *  backendVersion / policyDigest / mountTemplate / environmentTemplate /
 *  backendArgvTemplate / seccompObjectRef / validationResult。
 *
 *  不变量（LR2-2）：
 *  - 缓存键 = 全部 digest 分量组合 —— 任何分量变化 → 新键（无碰撞）；
 *  - 缓存内容为模板，**不得含**秘密值/真实 Token/临时端口/某次 Cell 的路径；
 *  - 运行时只允许注入：Cell identity / workspace path / resource values /
 *    arguments / secret handles / temporary paths（inject 白名单）。
 */

import { createHash } from "node:crypto"

export interface PlanCacheKey {
  profileDigest: string
  toolContractDigest: string
  runtimeVersion: string
  platform: string
  backendVersion: string
  policyDigest: string
}

/** 编译产物模板（无秘密、无 Cell 特定值）。 */
export interface CompiledSandboxPlan {
  key: PlanCacheKey
  mountTemplate: string
  environmentTemplate: Record<string, string>
  backendArgvTemplate: string[]
  seccompObjectRef?: string
  validationResult: { ok: boolean; errors: string[] }
  createdAt: number
}

/** 运行时注入白名单（模板不含、执行时注入的字段）。 */
export interface PlanRuntimeInjection {
  cellId: string
  runId: string
  workspacePath: string
  resourceValues: Record<string, number>
  arguments: string[]
  secretHandles: string[]
  temporaryPaths: string[]
}

export function planCacheKeyOf(input: Omit<PlanCacheKey, "policyDigest"> & { policyDigest: string }): PlanCacheKey {
  return { ...input }
}

/** 缓存键的稳定字符串（digest 组合）。 */
export function planKeyString(key: PlanCacheKey): string {
  return createHash("sha256")
    .update([
      key.profileDigest, key.toolContractDigest, key.runtimeVersion,
      key.platform, key.backendVersion, key.policyDigest,
    ].join("|"))
    .digest("hex")
}

/** 模板污染检查：模板中不得出现注入字段（秘密/路径/身份）。
 *  mountTemplate 是 JSON 字符串 —— 解析后递归检查字符串值（键名如
 *  "secrets" 是合法字段名，不误伤；泄漏形状只出现在值里）。 */
export function templateIsClean(plan: CompiledSandboxPlan): boolean {
  // 注入字段的典型形状（cell-/run-/token/secret 值/路径/端口）。
  // fail-closed 优先：宁可拒绝合法模板也不放过泄漏。
  const forbidden = [
    "cell-", "run-", "/workspace", "/tmp/orcana-", "token", "Bearer ", "bearer",
    "api_key", "sk-", "secret", ":8080", ":3000",
  ]
  const leaky = (value: string): boolean => forbidden.some(f => value.includes(f))

  // mountTemplate：解析 JSON 后递归值检查（无法解析 → 按原始字符串检查）。
  try {
    const parsed = JSON.parse(plan.mountTemplate) as unknown
    const stack: unknown[] = [parsed]
    while (stack.length > 0) {
      const item = stack.pop()
      if (typeof item === "string") {
        if (leaky(item)) return false
      } else if (Array.isArray(item)) {
        stack.push(...item)
      } else if (item && typeof item === "object") {
        stack.push(...Object.values(item))
      }
    }
  } catch {
    if (leaky(plan.mountTemplate)) return false
  }

  for (const v of Object.values(plan.environmentTemplate)) {
    if (leaky(v)) return false
  }
  for (const a of plan.backendArgvTemplate) {
    if (leaky(a)) return false
  }
  if (plan.seccompObjectRef && leaky(plan.seccompObjectRef)) return false
  return true
}

export class PlanCache {
  /** m6：LRU 上限（长期运行不无界增长）。 */
  private static readonly MAX_PLANS = 256
  private readonly plans = new Map<string, CompiledSandboxPlan>()

  /** 命中返回缓存计划；未命中 undefined（调用方编译后 put）。 */
  get(key: PlanCacheKey): CompiledSandboxPlan | undefined {
    const k = planKeyString(key)
    const plan = this.plans.get(k)
    if (plan) {
      // LRU：命中移到末尾（最近使用）
      this.plans.delete(k)
      this.plans.set(k, plan)
    }
    return plan
  }

  /** 放入缓存；模板污染（含秘密/路径）时拒绝（fail-closed）。 */
  put(plan: CompiledSandboxPlan): boolean {
    if (!templateIsClean(plan)) return false
    const k = planKeyString(plan.key)
    this.plans.delete(k)
    this.plans.set(k, plan)
    if (this.plans.size > PlanCache.MAX_PLANS) {
      const oldest = this.plans.keys().next().value
      if (oldest !== undefined) this.plans.delete(oldest)
    }
    return true
  }

  /** 注入运行时字段 → 展开后的执行视图（模板本身不变）。
   *  m2：替换后残留的 `{{` 占位符 → 报错（静默保留字面占位符会进入
   *  挂载源/环境/argv）。 */
  materialize(plan: CompiledSandboxPlan, injection: PlanRuntimeInjection): {
    mount: string
    environment: Record<string, string>
    argv: string[]
  } {
    // v1：模板为 JSON 字符串（mount 规则序列化）+ 环境键值 + argv 模板。
    // 注入按白名单替换占位符（{{cellId}} 等）—— 模板不含任何注入字段。
    const subst = (s: string): string => s
      .replaceAll("{{cellId}}", injection.cellId)
      .replaceAll("{{runId}}", injection.runId)
      .replaceAll("{{workspacePath}}", injection.workspacePath)
    const mount = subst(plan.mountTemplate)
    const environment = Object.fromEntries(
      Object.entries(plan.environmentTemplate).map(([k, v]) => [k, subst(v)]),
    )
    const argv = plan.backendArgvTemplate.map(subst)
    // 残留占位符检测（模板含未支持占位符 → fail-closed）。
    for (const v of [mount, ...Object.values(environment), ...argv]) {
      if (v.includes("{{")) {
        throw new Error(`unresolved template placeholder in materialized plan`)
      }
    }
    return { mount, environment, argv }
  }

  get size(): number {
    return this.plans.size
  }
}
