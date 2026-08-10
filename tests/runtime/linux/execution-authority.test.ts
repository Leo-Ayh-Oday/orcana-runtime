/** R2 PR-9：Execution Authority 测试（EA-001..003, EA-011, EA-014）。
 *  验证：UntrustedCapabilityRequest 无身份/宿主路径字段；
 *  编译时身份/工作区只来自 authority；enabled 无 authority fail-closed；
 *  模型 env 不能伪造身份键。 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { compileCapabilityRequest } from "../../../src/runtime/linux/policy-compiler"
import { createLinuxBroker } from "../../../src/runtime/linux/broker"
import type { TrustedExecutionAuthority } from "../../../src/runtime/linux/contracts"
import { LinuxExecutionError } from "../../../src/runtime/linux/errors"

function testAuthority(overrides: Partial<TrustedExecutionAuthority> = {}): TrustedExecutionAuthority {
  return {
    identity: { runId: "run-auth-1", nodeRunId: "run-auth-1:n1", attempt: 2, agentId: "agent-auth" },
    workspace: { workspaceId: "ws_auth", projectId: "p", hostRoot: process.cwd(), kind: "main", access: "readwrite", physicalWorkspaceKey: "wp_test", ownerFiles: [] },
    ...overrides,
  }
}

describe("Execution Authority (R2 PR-9)", () => {
  test("EA-001/002/003: request cannot declare identity/workspace fields (type-level: fields removed from UntrustedCapabilityRequest)", () => {
    // 类型级保证：UntrustedCapabilityRequest 无 runId/agentId/worktreeRoot/ownerFiles。
    // 运行级：传入额外键必须被忽略（TS 会拒绝，这里用 any 验证编译器不读取）。
    const extra = { command: { executable: "/bin/true", args: [] }, profile: "build", runId: "fake", agentId: "fake", worktreeRoot: "/etc", ownerFiles: ["x"] } as unknown as Parameters<typeof compileCapabilityRequest>[0]
    const result = compileCapabilityRequest(extra, testAuthority())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.spec.identity.runId).toBe("run-auth-1")
      expect(result.spec.identity.agentId).toBe("agent-auth")
      expect(result.spec.filesystem.worktreeRoot).toBe(process.cwd())
      expect(result.spec.filesystem.ownerFiles).toEqual([])
    }
  })

  test("authority identity/attempt is authoritative (request cannot override)", () => {
    const result = compileCapabilityRequest({ command: { executable: "/bin/true", args: [] }, profile: "build" }, testAuthority())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.spec.identity.runId).toBe("run-auth-1")
      expect(result.spec.identity.nodeRunId).toBe("run-auth-1:n1")
      expect(result.spec.identity.attempt).toBe(2)
      expect(result.spec.identity.agentId).toBe("agent-auth")
      expect(result.spec.identity.cellId.startsWith("cell-")).toBe(true)
    }
  })

  test("relative cwd resolved against authority workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "ea-"))
    try {
      const result = compileCapabilityRequest(
        { command: { executable: "/bin/true", args: [], relativeCwd: "." }, profile: "build" },
        testAuthority({ workspace: { workspaceId: "ws_auth", projectId: "p", hostRoot: root, kind: "main", access: "readwrite", physicalWorkspaceKey: "wp_test", ownerFiles: [] } }),
      )
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.spec.command.cwd).toBe(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("EA-011: enabled broker rejects compileRequest without authority", () => {
    const broker = createLinuxBroker({ mode: "enabled" })
    expect(() => broker.compileRequest({ command: { executable: "/bin/true", args: [] }, profile: "build" }))
      .toThrow(LinuxExecutionError)
    try {
      broker.compileRequest({ command: { executable: "/bin/true", args: [] }, profile: "build" })
      throw new Error("expected EXECUTION_AUTHORITY_MISSING")
    } catch (error) {
      expect(String(error)).toMatch(/EXECUTION_AUTHORITY_MISSING|authority/i)
    }
  })

  test("EA-012: shadow mode allows explicit test authority", () => {
    const broker = createLinuxBroker({ mode: "shadow" })
    const spec = broker.compileRequest({ command: { executable: "/bin/true", args: [] }, profile: "build" }, testAuthority())
    expect(spec.identity.runId).toBe("run-auth-1")
  })

  test("EA-014: model env cannot forge identity keys (hostKeyDenied covers ORCANA_*?)", () => {
    // ORCANA_RUN_ID 属于 ORCANA_* 前缀 —— 环境拒绝规则不允许伪造内部键：
    // 编译产物身份取自 authority，env 键只是环境变量，不会成为 identity。
    const result = compileCapabilityRequest(
      { command: { executable: "/bin/true", args: [] }, profile: "build", env: { ORCANA_RUN_ID: "forged" } },
      testAuthority(),
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.spec.identity.runId).toBe("run-auth-1")
      expect(result.spec.environment.variables.ORCANA_RUN_ID).toBe("forged")
    }
  })
})
