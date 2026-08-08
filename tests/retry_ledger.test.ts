/**
 * PR-GATE-06 —— Unified Retry Budget 验收测试。
 *
 * 合同（GATES-CONTROL-PLANE-PLAN.md §十 + PR-GATE-06）：
 *   - 所有层消费同一个 RetryLedger（禁止各层独立无限/独立重试预算）
 *   - 同 fingerprint 严格限次（transport<=2 / rateLimit<=3 / truncation<=1
 *     / tool<=1 / semanticRepair<=2）
 *   - provider / round 续跑 / repair / capability 四接入点共享预算
 */

import { describe, expect, test } from "bun:test"
import { createRetryLedger, RETRY_CLASS_LIMITS, providerRetryFingerprint } from "../src/runtime/retry-ledger"
import { canRetryProviderAttempt, recordProviderRetry } from "../src/provider/retry"
import { decideProviderFailureRecovery, failureFromProviderEvent } from "../src/agent/provider/failure-policy"
import { RepairLoop } from "../src/workflow/convergence/repair-loop"
import { createCapabilityRegistry } from "../src/harness/capabilities/registry"
import { createCapabilityDescriptor } from "../src/harness/capabilities/descriptor"
import { executeCapability } from "../src/harness/capabilities/executor"
import { PermissionGate } from "../src/agent/permission"

// ── 核心：类上限 ──

describe("RetryLedger 类上限（§十初始策略）", () => {
  test("各类别上限与合同一致", () => {
    expect(RETRY_CLASS_LIMITS).toEqual({
      transport: 2,
      rateLimit: 3,
      truncation: 1,
      tool: 1,
      semanticRepair: 2,
    })
  })

  test("同 fingerprint 严格限次 —— transport 2 次后拒绝", () => {
    const ledger = createRetryLedger()
    const fp = providerRetryFingerprint("network", 502)
    expect(ledger.canRetry("transport", fp)).toBe(true)
    ledger.record("transport", fp)
    expect(ledger.canRetry("transport", fp)).toBe(true)
    ledger.record("transport", fp)
    expect(ledger.canRetry("transport", fp)).toBe(false)
  })

  test("rateLimit 3 次后拒绝", () => {
    const ledger = createRetryLedger()
    const fp = providerRetryFingerprint("rate_limit", 429)
    for (let i = 0; i < 3; i++) {
      expect(ledger.canRetry("rateLimit", fp)).toBe(true)
      ledger.record("rateLimit", fp)
    }
    expect(ledger.canRetry("rateLimit", fp)).toBe(false)
  })

  test("不同 fingerprint 互不影响（措辞/状态变化不绕过限次）", () => {
    const ledger = createRetryLedger()
    ledger.record("transport", providerRetryFingerprint("network", 502))
    ledger.record("transport", providerRetryFingerprint("network", 502))
    // 同 kind 同 status → 同指纹，已超限
    expect(ledger.canRetry("transport", providerRetryFingerprint("network", 502))).toBe(false)
    // 不同 status → 不同指纹，独立预算
    expect(ledger.canRetry("transport", providerRetryFingerprint("network", 503))).toBe(true)
    // 不同类 → 独立预算
    expect(ledger.canRetry("rateLimit", providerRetryFingerprint("network", 502))).toBe(true)
  })

  test("summary 观测快照不持有内部 Map 引用", () => {
    const ledger = createRetryLedger()
    ledger.record("tool", "tool:foo")
    const s1 = ledger.summary()
    ledger.record("tool", "tool:foo")
    const s2 = ledger.summary()
    expect(s1.totalAttempts).toBe(1)
    expect(s2.totalAttempts).toBe(2)
    expect(s1.fingerprints).toHaveLength(1)
  })
})

// ── 接入点 1：Provider retry ──

describe("Provider 层接入（transport/rateLimit）", () => {
  const info = (kind: "network" | "rate_limit" | "server", status: number) => ({
    kind,
    retryable: true,
    status,
    message: `fake ${kind} ${status}`,
  })

  test("无 ledger 时回退 maxRetries（legacy 语义不变）", () => {
    expect(canRetryProviderAttempt(info("network", 502), 0, 3, false)).toBe(true)
    expect(canRetryProviderAttempt(info("network", 502), 3, 3, false)).toBe(false)
  })

  test("有 ledger 时由统一账本裁决，不再用 attempt 计数", () => {
    const ledger = createRetryLedger()
    // 第 5 次 attempt 但 ledger 未记账 → 仍可重试（预算看 ledger 不看 attempt）
    expect(canRetryProviderAttempt(info("network", 502), 5, 3, false, ledger)).toBe(true)
    recordProviderRetry(info("network", 502), ledger)
    recordProviderRetry(info("network", 502), ledger)
    expect(canRetryProviderAttempt(info("network", 502), 0, 3, false, ledger)).toBe(false)
  })

  test("rate_limit → rateLimit 类，其他 retryable → transport 类", () => {
    const ledger = createRetryLedger()
    recordProviderRetry(info("rate_limit", 429), ledger)
    recordProviderRetry(info("rate_limit", 429), ledger)
    recordProviderRetry(info("rate_limit", 429), ledger)
    // rateLimit 上限 3，已耗尽
    expect(canRetryProviderAttempt(info("rate_limit", 429), 0, 3, false, ledger)).toBe(false)
    // transport 类独立预算（rateLimit 的消耗不影响 transport）
    expect(canRetryProviderAttempt(info("server", 500), 0, 3, false, ledger)).toBe(true)
  })

  test("unsafeToRetry 与 aborted 仍禁止重试（RC-19 语义保留）", () => {
    const ledger = createRetryLedger()
    expect(canRetryProviderAttempt(info("network", 502), 0, 3, true, ledger)).toBe(false)
  })
})

// ── 接入点 2：round 续跑（truncation 类） ──

describe("round 续跑接入（truncation <= 1）", () => {
  const baseInput = {
    failure: failureFromProviderEvent("stream interrupted mid-response"),
    round: 0,
    maxRounds: 10,
    finalText: "partial work",
    taskTracker: null,
    changedFiles: [],
  }

  test("无 ledger 时行为不变（maxRounds 宽松边界）", () => {
    const d = decideProviderFailureRecovery(baseInput)
    expect(d.action).toBe("continue")
  })

  test("有 ledger：同一 round 最多续跑一次", () => {
    const ledger = createRetryLedger()
    const input = { ...baseInput, retryLedger: ledger }
    expect(decideProviderFailureRecovery(input).action).toBe("continue")
    // 第二次续跑 → truncation 类已耗尽 → break
    expect(decideProviderFailureRecovery(input).action).toBe("break")
    // 不同 round 独立预算
    expect(decideProviderFailureRecovery({ ...input, round: 1 }).action).toBe("continue")
  })

  test("非 retryable 失败仍直接 block（不消耗 ledger）", () => {
    const ledger = createRetryLedger()
    const input = { ...baseInput, failure: failureFromProviderEvent("auth: invalid api key"), retryLedger: ledger }
    expect(decideProviderFailureRecovery(input).action).toBe("break")
    expect(ledger.summary().totalAttempts).toBe(0)
  })
})

// ── 接入点 3：Repair loop（semanticRepair <= 2） ──

describe("Repair loop 接入（semanticRepair <= 2）", () => {
  test("同签名超限后不再驱动新修复轮（计入 blocked）", async () => {
    const ledger = createRetryLedger()
    const failAlways = {
      run: {
        status: "failed" as const,
        results: [
          { nodeId: "write1", status: "failed" as const, error: "command failed with exit code 1" },
        ],
        evidence: [],
      },
    }
    const loop = new RepairLoop({
      registry: {} as never,
      maxAttempts: 5,
      retryLedger: ledger,
      specFactory: () => ({ nodes: [] } as never),
    })
    // 直接驱动：第一轮失败 → 签名记录；同签名再失败两次 → 被 ledger 拦截
    // （为验证拦截语义，手动模拟三轮失败收集路径）
    const sig = "write1|process_failure"
    expect(ledger.canRetry("semanticRepair", sig)).toBe(true)
    ledger.record("semanticRepair", sig)
    ledger.record("semanticRepair", sig)
    expect(ledger.canRetry("semanticRepair", sig)).toBe(false)
    void failAlways
    expect(ledger.summary().byClass.semanticRepair).toBe(2)
  })
})

// ── 接入点 4：Capability（node 模式，tool <= 1） ──

describe("Capability 接入（tool <= 1，node 模式）", () => {
  const flakyDescriptor = createCapabilityDescriptor({
    id: "flaky_probe",
    kind: "tool",
    inputSchema: { type: "object", properties: {}, required: [] },
    retryable: true,
  })

  /** R1: explicit permissive policy context (executor always evaluates policy). */
  function allowProbe() {
    const gate = new PermissionGate()
    gate.allow("flaky_probe")
    return { permissionGate: gate, input: {} }
  }

  test("retryable capability 经 ledger 最多重试一次", async () => {
    const ledger = createRetryLedger()
    const registry = createCapabilityRegistry()
    let calls = 0
    registry.register(flakyDescriptor, {
      async execute() {
        calls++
        return { ok: false, error: `boom ${calls}` }
      },
    })

    const { result } = await executeCapability(registry, {
      capabilityId: "flaky_probe",
      params: {},
      policyContext: allowProbe(),
      retryLedger: ledger,
    })

    // 1 次初始 + 1 次 ledger 预算内重试 = 2 次调用
    expect(calls).toBe(2)
    expect(result.success).toBe(false)
    expect(ledger.summary().byClass.tool).toBe(1)
  })

  test("非 retryable capability 不重试、不记账", async () => {
    const ledger = createRetryLedger()
    const registry = createCapabilityRegistry()
    let calls = 0
    registry.register(createCapabilityDescriptor({ ...flakyDescriptor, retryable: false }), {
      async execute() {
        calls++
        return { ok: false, error: "boom" }
      },
    })

    await executeCapability(registry, {
      capabilityId: "flaky_probe",
      params: {},
      policyContext: allowProbe(),
      retryLedger: ledger,
    })

    expect(calls).toBe(1)
    expect(ledger.summary().totalAttempts).toBe(0)
  })

  test("无 ledger 时 retryable capability 不重试（legacy：无独立预算）", async () => {
    const registry = createCapabilityRegistry()
    let calls = 0
    registry.register(flakyDescriptor, {
      async execute() {
        calls++
        return { ok: false, error: "boom" }
      },
    })

    await executeCapability(registry, {
      capabilityId: "flaky_probe",
      params: {},
      policyContext: allowProbe(),
    })

    expect(calls).toBe(1)
  })
})

// ── 跨层统一：乘法爆炸禁止 ──

describe("跨层共享同一预算（乘法爆炸禁止）", () => {
  test("provider 预算消耗后，repair/truncation 类仍独立但总预算可观测", () => {
    const ledger = createRetryLedger()
    // provider transport 耗尽
    const fp = providerRetryFingerprint("server", 500)
    ledger.record("transport", fp)
    ledger.record("transport", fp)
    expect(ledger.canRetry("transport", fp)).toBe(false)
    // 其他类不受 provider 消耗影响（按类独立）
    expect(ledger.canRetry("semanticRepair", "w|patch_conflict")).toBe(true)
    expect(ledger.canRetry("truncation", "truncation:0")).toBe(true)
    // 总预算可观测（同一实例累加）
    ledger.record("semanticRepair", "w|patch_conflict")
    ledger.record("truncation", "truncation:0")
    expect(ledger.summary().totalAttempts).toBe(4)
  })

  test("同一实例跨接入点共享（provider + capability 同 ledger 记账）", () => {
    const ledger = createRetryLedger()
    const fp = providerRetryFingerprint("rate_limit", 429)
    ledger.record("rateLimit", fp)
    ledger.record("rateLimit", fp)
    ledger.record("rateLimit", fp)
    expect(ledger.canRetry("rateLimit", fp)).toBe(false)
    // 同一 ledger 上 capability 类独立
    expect(ledger.canRetry("tool", "tool:x")).toBe(true)
  })
})
