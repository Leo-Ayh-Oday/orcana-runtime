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

/** 模板污染检查：模板中不得出现注入字段（秘密/路径/身份）。 */
export function templateIsClean(plan: CompiledSandboxPlan): boolean {
  const blob = JSON.stringify({
    mount: plan.mountTemplate,
    env: plan.environmentTemplate,
    argv: plan.backendArgvTemplate,
    seccomp: plan.seccompObjectRef ?? "",
  })
  // 注入字段的典型形状（cell-/run-/ws-/token/secret/port）不得出现在模板。
  const forbidden = [
    "cell-", "run-", "/workspace", "/tmp/orcana-", "token", "secret", "bearer",
    ":8080", ":3000",
  ]
  return !forbidden.some(f => blob.includes(f))
}

export class PlanCache {
  private readonly plans = new Map<string, CompiledSandboxPlan>()

  /** 命中返回缓存计划；未命中 undefined（调用方编译后 put）。 */
  get(key: PlanCacheKey): CompiledSandboxPlan | undefined {
    return this.plans.get(planKeyString(key))
  }

  /** 放入缓存；模板污染（含秘密/路径）时拒绝（fail-closed）。 */
  put(plan: CompiledSandboxPlan): boolean {
    if (!templateIsClean(plan)) return false
    this.plans.set(planKeyString(plan.key), plan)
    return true
  }

  /** 注入运行时字段 → 展开后的执行视图（模板本身不变）。 */
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
    return {
      mount: subst(plan.mountTemplate),
      environment: Object.fromEntries(
        Object.entries(plan.environmentTemplate).map(([k, v]) => [k, subst(v)]),
      ),
      argv: plan.backendArgvTemplate.map(subst),
    }
  }

  get size(): number {
    return this.plans.size
  }
}
