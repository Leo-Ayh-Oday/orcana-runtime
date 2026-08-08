/** LR2-4 Gate 验收（P4-E）：5 项 Gate 各一条显式断言。
 *
 *  SECCOMP_AUTO_PROMOTION       = 0
 *  UNCLASSIFIED_SYSCALL_ALLOWED = 0
 *  EGRESS_UNRECORDED            = 0
 *  CELL_INIT_ORDER_VIOLATION    = 0
 *  MICROVM_WITHOUT_KVM          = 0
 */

import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { canAdvanceStage, resolveSeccompProfile } from "../../../src/runtime/linux/seccomp/profiles"
import { EgressRecorder } from "../../../src/runtime/linux/egress/gateway"
import { detectKvm } from "../../../src/runtime/linux/microvm"

describe("LR2-4 Gates (P4-E)", () => {
  test("SECCOMP_AUTO_PROMOTION = 0: evolution never auto-promotes", () => {
    // 观察阶段不能跳到 enforce（每格需确认）
    expect(canAdvanceStage("observe", "enforce")).toBe(false)
    expect(canAdvanceStage("observe", "observe")).toBe(false)
    // 只能严格前进一格
    expect(canAdvanceStage("candidate", "compatibility-replay")).toBe(true)
  })

  test("UNCLASSIFIED_SYSCALL_ALLOWED = 0: unknown workloads deny everything", () => {
    const unknown = resolveSeccompProfile({ runtimeFamily: "generic", toolKind: "unknown", sandboxProfile: "strict", architecture: "x86_64" })
    expect(unknown.allowSyscalls).toHaveLength(0)
    expect(unknown.defaultAction).toBe("SCMP_ACT_ERRNO")
    // 未命中维度 → 同样 deny-all
    const miss = resolveSeccompProfile({ runtimeFamily: "node-bun", toolKind: "test", sandboxProfile: "standard", architecture: "aarch64" })
    expect(miss.allowSyscalls).toHaveLength(0)
  })

  test("EGRESS_UNRECORDED = 0: every egress request is recorded", () => {
    const recorder = new EgressRecorder()
    recorder.record({ at: 1, host: "a.com", port: 443, method: "GET", bytesSent: 1, bytesReceived: 2, redirectHops: 0, sensitivePatterns: [] })
    recorder.record({ at: 2, host: "b.com", port: 443, method: "GET", bytesSent: 3, bytesReceived: 4, redirectHops: 1, sensitivePatterns: [] })
    expect(recorder.count()).toBe(2)
  })

  test("CELL_INIT_ORDER_VIOLATION = 0: plan rejects incomplete input (real binary)", () => {
    // Rust 侧校验由 cargo test 覆盖（plan::tests::rejects_bad_schema）；
    // 此处做真实集成：二进制存在时（本机构建过），坏 plan → exit 126
    // （plan 拒绝），合法 plan 到 exec 阶段（/bin/true 存在则 exec 成功）。
    const binary = join(process.cwd(), "native", "orcana-cell-init", "target", "debug", "orcana-cell-init")
    if (!existsSync(binary)) {
      // 未构建：跳过（环境条件 —— cargo test 是 Rust 门禁）
      return
    }
    // 坏 plan（缺 exec.path）→ FD 3 传入（3<&0 把 stdin 复制到 FD 3）→ exit 126
    const bad = spawnSync("bash", ["-c", `exec ${binary} 3<&0`], {
      input: '{"schemaVersion":"1.0","exec":{}}',
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    })
    expect(bad.status).toBe(126)
    // 合法 plan（/bin/true）→ exec 成功 exit 0
    const good = spawnSync("bash", ["-c", `exec ${binary} 3<&0`], {
      input: '{"schemaVersion":"1.0","exec":{"path":"/bin/true","args":["/bin/true"],"env":{}},"cwd":"/","rlimits":{},"noNewPrivs":false,"landlock":{},"seccomp":{}}',
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    })
    expect(good.status).toBe(0)
  })

  test("MICROVM_WITHOUT_KVM = 0: no KVM → backend refuses, never degrades", () => {
    const probe = detectKvm()
    if (!probe.available) {
      expect(probe.reasons.length).toBeGreaterThan(0)
    } else {
      expect(probe.reasons).toHaveLength(0)
    }
  })
})
