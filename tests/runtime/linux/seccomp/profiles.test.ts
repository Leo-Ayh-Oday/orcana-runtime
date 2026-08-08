/** LR2-4（P4-A）：seccomp Profile 体系验收 —— 维度键 / unknown-deny
 *  默认拒绝 / 演进状态机无自动晋升 / 编译输出。 */

import { describe, expect, test } from "bun:test"
import {
  FIRST_BATCH_PROFILES, canAdvanceStage, resolveSeccompProfile,
  seccompProfileKeyOf, type SeccompProfileKey,
} from "../../../../src/runtime/linux/seccomp/profiles"
import { compileSeccompBpf } from "../../../../src/runtime/linux/seccomp-bpf"

const KEY: SeccompProfileKey = { runtimeFamily: "node-bun", toolKind: "build", sandboxProfile: "strict", architecture: "x86_64" }

describe("seccomp profiles (P4-A)", () => {
  test("dimension key is stable and order-sensitive", () => {
    expect(seccompProfileKeyOf(KEY)).toBe("node-bun:build:strict:x86_64")
    expect(seccompProfileKeyOf({ ...KEY, toolKind: "readonly" })).not.toBe(seccompProfileKeyOf(KEY))
  })

  test("six first-batch profiles exist and resolve", () => {
    expect(FIRST_BATCH_PROFILES).toHaveLength(6)
    for (const p of FIRST_BATCH_PROFILES) {
      const resolved = resolveSeccompProfile(p.key)
      expect(resolved.defaultAction).toBe("SCMP_ACT_ERRNO") // 默认拒绝
    }
  })

  test("unknown-deny denies everything (UNCLASSIFIED_SYSCALL_ALLOWED)", () => {
    const unknown = resolveSeccompProfile({ runtimeFamily: "generic", toolKind: "unknown", sandboxProfile: "strict", architecture: "x86_64" })
    expect(unknown.allowSyscalls).toHaveLength(0)
    // 未命中维度 → unknown-deny 语义（默认拒绝）
    const miss = resolveSeccompProfile({ runtimeFamily: "node-bun", toolKind: "test", sandboxProfile: "standard", architecture: "aarch64" })
    expect(miss.allowSyscalls).toHaveLength(0)
  })

  test("evolution advances one step at a time, never auto-promotes (SECCOMP_AUTO_PROMOTION)", () => {
    expect(canAdvanceStage("observe", "candidate")).toBe(true)
    expect(canAdvanceStage("candidate", "compatibility-replay")).toBe(true)
    expect(canAdvanceStage("compatibility-replay", "security-replay")).toBe(true)
    expect(canAdvanceStage("security-replay", "canary")).toBe(true)
    expect(canAdvanceStage("canary", "enforce")).toBe(true)
    // 不能跳级 / 不能自动晋升
    expect(canAdvanceStage("observe", "enforce")).toBe(false)
    expect(canAdvanceStage("observe", "observe")).toBe(false)
    expect(canAdvanceStage("enforce", "enforce")).toBe(false)
    expect(canAdvanceStage("candidate", "canary")).toBe(false)
  })

  test("first-batch profiles compile to non-empty BPF", () => {
    for (const { profile } of FIRST_BATCH_PROFILES) {
      const bpf = compileSeccompBpf(profile)
      expect(bpf.length).toBeGreaterThan(0)
    }
  })
})
