/** LR2-2（P2-A）：Plan Cache 验收 —— 命中不重编译 / 跨 policy 不共享 /
 *  模板无秘密（golden）/ 注入白名单。 */

import { describe, expect, test } from "bun:test"
import { PlanCache, planCacheKeyOf, planKeyString, templateIsClean, type CompiledSandboxPlan } from "../../../../src/runtime/linux/cache/plan-cache"

function cleanPlan(overrides: Partial<CompiledSandboxPlan> = {}): CompiledSandboxPlan {
  return {
    key: planCacheKeyOf({
      profileDigest: "p1", toolContractDigest: "t1", runtimeVersion: "bun-1.3",
      platform: "linux-x64", backendVersion: "host-audit-1", policyDigest: "pol1",
    }),
    mountTemplate: '{"workspace":"{{workspacePath}}"}',
    environmentTemplate: { PATH: "{{workspacePath}}/bin", HOME: "/home/orcana" },
    backendArgvTemplate: ["{{runId}}", "{{cellId}}"],
    validationResult: { ok: true, errors: [] },
    createdAt: 1,
    ...overrides,
  }
}

describe("PlanCache (P2-A)", () => {
  test("same key hits without recompilation", () => {
    const cache = new PlanCache()
    const plan = cleanPlan()
    expect(cache.put(plan)).toBe(true)
    const hit = cache.get(plan.key)
    expect(hit).toBeDefined()
    expect(hit!.key.policyDigest).toBe("pol1")
    expect(cache.size).toBe(1)
  })

  test("different policyDigest never shares (CACHE_CROSS_POLICY_REUSE)", () => {
    const cache = new PlanCache()
    const a = cleanPlan()
    const b = cleanPlan({ key: { ...a.key, policyDigest: "pol2" } })
    cache.put(a)
    expect(cache.get(b.key)).toBeUndefined()
    // 键字符串不同（digest 组合）
    expect(planKeyString(a.key)).not.toBe(planKeyString(b.key))
  })

  test("any digest component change produces a new key (no collision)", () => {
    const base = planCacheKeyOf({
      profileDigest: "p", toolContractDigest: "t", runtimeVersion: "r",
      platform: "pl", backendVersion: "b", policyDigest: "pol",
    })
    for (const component of ["profileDigest", "toolContractDigest", "runtimeVersion", "platform", "backendVersion", "policyDigest"] as const) {
      const variant = { ...base, [component]: base[component] + "-x" }
      expect(planKeyString(variant)).not.toBe(planKeyString(base))
    }
  })

  test("template with secrets/paths is rejected (fail-closed)", () => {
    const cache = new PlanCache()
    const poisoned = cleanPlan({
      mountTemplate: '{"source":"/home/user/secret-data"}',
    })
    expect(templateIsClean(poisoned)).toBe(false)
    expect(cache.put(poisoned)).toBe(false)
    expect(cache.size).toBe(0)
  })

  test("materialize injects runtime fields only (template unchanged)", () => {
    const cache = new PlanCache()
    const plan = cleanPlan()
    cache.put(plan)
    const out = cache.materialize(plan, {
      cellId: "cell-1", runId: "run-1", workspacePath: "/ws/1",
      resourceValues: { memoryMaxBytes: 1024 }, arguments: ["--flag"],
      secretHandles: ["s1"], temporaryPaths: ["/tmp/x"],
    })
    expect(out.mount).toContain("/ws/1")
    expect(out.environment.PATH).toBe("/ws/1/bin")
    expect(out.argv).toEqual(["run-1", "cell-1"])
    // 模板本身不含注入值
    expect(plan.mountTemplate).not.toContain("/ws/1")
  })

  test("golden: clean template passes, typical leak patterns caught", () => {
    expect(templateIsClean(cleanPlan())).toBe(true)
    for (const leak of [
      '{"x":"cell-abc123"}',
      '{"x":"run-xyz"}',
      '{"x":"/workspace"}',
      '{"x":"/tmp/orcana-cell"}',
      '{"x":"Bearer token123"}',
      '{"x":"localhost:8080"}',
    ]) {
      expect(templateIsClean(cleanPlan({ mountTemplate: leak }))).toBe(false)
    }
  })
})
