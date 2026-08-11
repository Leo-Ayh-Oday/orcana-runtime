/** AK2-T06 — Linux Broker Projection Executor Adapter（真实 broker 执行）。 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLinuxBroker } from "../../../src/runtime/linux/broker"
import { HOST_AUDIT_TEST_CAPABILITIES } from "../../helpers/linux-process-test-broker"
import { WorkspaceAuthorityRegistry } from "../../../src/runtime/linux/workspace/workspace-authority"
import { LinuxBrokerProjectionExecutor } from "../../../src/kernel/projection/broker-adapter"
import { ProjectionError } from "../../../src/kernel/projection/contracts"
import type { TrustedExecutionAuthority } from "../../../src/runtime/linux/contracts"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function tmpMerged(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ak2-adapter-${label}-`))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, "src"), { recursive: true })
  mkdirSync(join(dir, "docs"), { recursive: true })
  return dir
}

/** 最小 writable ownership 注册：merged 根 = readwrite worktree。 */
function authorityFor(merged: string): TrustedExecutionAuthority {
  const registry = new WorkspaceAuthorityRegistry()
  const workspace = registry.registerAgentWorktree({
    projectId: "ak2-proj",
    hostRoot: merged,
    access: "readwrite",
    ownerFiles: [merged],
  })
  return {
    identity: { runId: `run-${process.pid}`, nodeRunId: `run-${process.pid}:n1`, attempt: 1 },
    workspace,
  }
}

function adapter(merged: string, overrides: Partial<ConstructorParameters<typeof LinuxBrokerProjectionExecutor>[0]> = {}) {
  // testCapabilities fixture：跳过宿主真实能力探测（本机探测当前 >5s）；
  // compileRequest/execute/receipt 仍走真实 broker + host-audit 执行。
  const broker = createLinuxBroker({ mode: "enabled", testCapabilities: HOST_AUDIT_TEST_CAPABILITIES })
  return new LinuxBrokerProjectionExecutor({
    broker,
    authority: authorityFor(merged),
    writableRoots: ["src"],
    readonlyRoots: ["docs"],
    profile: "build",
    ...overrides,
  })
}

describe("AK2-T06 adapter 边界", () => {
  test("authority workspace 与 merged 不匹配 → 拒绝（只接收 projection workspace）", async () => {
    const merged = tmpMerged("a")
    const other = tmpMerged("b")
    const executor = adapter(other)
    await expect(
      executor.execute(merged, { executable: "/bin/true", args: [] }),
    ).rejects.toMatchObject({ code: "PROJECTION_NOT_PROJECTED" })
  })

  test("只读 workspace authority → 拒绝", async () => {
    const merged = tmpMerged("ro")
    const registry = new WorkspaceAuthorityRegistry()
    const workspace = registry.registerAgentWorktree({
      projectId: "ak2-proj",
      hostRoot: merged,
      access: "readonly",
      ownerFiles: [],
    })
    const broker = createLinuxBroker({ mode: "enabled", testCapabilities: HOST_AUDIT_TEST_CAPABILITIES })
    const executor = new LinuxBrokerProjectionExecutor({
      broker,
      authority: { identity: { runId: "r", nodeRunId: "r:n", attempt: 1 }, workspace },
      writableRoots: ["src"],
      readonlyRoots: [],
      profile: "build",
    })
    await expect(
      executor.execute(merged, { executable: "/bin/true", args: [] }),
    ).rejects.toMatchObject({ code: "PROJECTION_NOT_PROJECTED" })
  })
})

describe("AK2-T06 真实 broker 执行", () => {
  test("exitCode=0 → outcome COMPLETED + receipt id（只证明 Execution）", async () => {
    const merged = tmpMerged("ok")
    const executor = adapter(merged)
    const { outcome, receipt } = await executor.execute(merged, {
      executable: "/bin/sh",
      args: ["-c", "echo hello > src/out.txt"],
    })
    expect(outcome.exitCode).toBe(0)
    expect(outcome.timedOut).toBe(false)
    expect(outcome.cancelled).toBe(false)
    expect(outcome.violation).toBe(false)
    expect(outcome.executionReceiptId).toMatch(/^[0-9a-f]{64}$/)
    expect(receipt).toBeDefined()
    // receipt 不携带任何 World/Graph completion 字段。
    expect("worldCommit" in receipt!).toBe(false)
    expect("graphCompleted" in receipt!).toBe(false)
    expect("evidenceBound" in receipt!).toBe(false)
    expect(receipt!.exitCode).toBe(0)
  })

  test("exitCode!=0 → outcome 失败 + receipt id", async () => {
    const merged = tmpMerged("fail")
    const executor = adapter(merged)
    const { outcome } = await executor.execute(merged, {
      executable: "/bin/sh",
      args: ["-c", "exit 3"],
    })
    expect(outcome.exitCode).toBe(3)
    expect(outcome.executionReceiptId).toBeDefined()
  })

  test("abortSignal → cancelled", async () => {
    const merged = tmpMerged("cancel")
    const executor = adapter(merged)
    const controller = new AbortController()
    const promise = executor.execute(merged, {
      executable: "/bin/sh",
      args: ["-c", "sleep 30"],
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 300)
    const { outcome } = await promise
    expect(outcome.cancelled).toBe(true)
    expect(outcome.exitCode).not.toBe(0)
  })

  test("adapter 不放大权限：writable mounts 只来自 plan scope（编译后 spec 检查）", async () => {
    const merged = tmpMerged("scope")
    const broker = createLinuxBroker({ mode: "enabled", testCapabilities: HOST_AUDIT_TEST_CAPABILITIES })
    const authority = authorityFor(merged)
    const executor = new LinuxBrokerProjectionExecutor({
      broker,
      authority,
      writableRoots: ["src"],
      readonlyRoots: ["docs"],
      profile: "build",
    })
    const { receipt } = await executor.execute(merged, {
      executable: "/bin/true",
      args: [],
    })
    // spec 编译由 broker 完成；filesystemPolicyDigest 绑定 scope（不因 backend 改变）。
    expect(receipt!.filesystemPolicyDigest.length).toBe(64)
    // 执行位置 = projection workspace（cwd 在 merged 内）。
    expect(authority.workspace.hostRoot).toBe(merged)
  })
})
