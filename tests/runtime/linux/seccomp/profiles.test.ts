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

  test("unknown-deny allows only exit primitives (UNCLASSIFIED_SYSCALL_ALLOWED)", () => {
    const unknown = resolveSeccompProfile({ runtimeFamily: "generic", toolKind: "unknown", sandboxProfile: "strict", architecture: "x86_64" })
    // M4 修复：只允许退出/最小 I/O 原语（进程必须能干净退出，不得空转挂起）
    expect(unknown.allowSyscalls).not.toContain("execve")
    expect(unknown.allowSyscalls).not.toContain("clone")
    expect(unknown.allowSyscalls).not.toContain("socket")
    expect(unknown.allowSyscalls).not.toContain("openat")
    expect(unknown.allowSyscalls).toContain("exit")
    expect(unknown.allowSyscalls).toContain("rt_sigreturn")
    // 未命中维度 → unknown-deny 语义（默认拒绝）
    const miss = resolveSeccompProfile({ runtimeFamily: "node-bun", toolKind: "test", sandboxProfile: "standard", architecture: "aarch64" })
    expect(miss.allowSyscalls).not.toContain("execve")
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

// ── LR2-4 审核修复验收（B1/M2/M3/M4）──

describe("Seccomp audit fixes (B1/M2/M3/M4)", () => {
  test("B1: every first-batch profile compiles without silent drops (semantics = declaration)", () => {
    // 此前 build 丢 36/86 条（mkdir/rename 等全删）—— 现在任何未知
    // syscall 名都会抛错（拒绝生成）。
    for (const { profile } of FIRST_BATCH_PROFILES) {
      const bpf = compileSeccompBpf(profile)
      expect(bpf.length).toBeGreaterThan(0)
    }
  })

  test("M2/M3: rt_sigreturn and clone are present in runtime profiles", () => {
    const build = resolveSeccompProfile({ runtimeFamily: "node-bun", toolKind: "build", sandboxProfile: "strict", architecture: "x86_64" })
    expect(build.allowSyscalls).toContain("rt_sigreturn")
    expect(build.allowSyscalls).toContain("clone")
    expect(build.allowSyscalls).toContain("getcwd")
  })

  test("M4: readonly profiles can execve (target must start)", () => {
    const readonly = resolveSeccompProfile({ runtimeFamily: "node-bun", toolKind: "readonly", sandboxProfile: "strict", architecture: "x86_64" })
    expect(readonly.allowSyscalls).toContain("execve")
  })
})
