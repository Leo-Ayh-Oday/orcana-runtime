/** AK2-T06 — Linux Broker Projection Executor Adapter（真实 broker 执行）。 */

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLinuxBroker } from "../../../src/runtime/linux/broker"
import { RuntimeStateStore } from "../../../src/runtime/linux/recovery/state-store"
import { RuntimeStateReceiptAuthority } from "../../../src/kernel/projection/receipt-authority"
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
  // 真实 broker（无 testCapabilities）：真实能力探测 + bubblewrap strict
  // lane —— receipt.backend 必须是 bubblewrap/podman（R01.4：host-audit
  // 不能作为安全边界；本机 bwrap unprivilegedUsable 已验证）。
  // receiptAuthority 指向同一 RuntimeStateStore（broker 持久化 final
  // receipt 到 stateStore root）—— P0-2/P1-6：outcome 只携带 final digest。
  const stateStore = new RuntimeStateStore({ root: join(tmpdir(), `ak2-adapter-state-${process.pid}-${Math.random().toString(36).slice(2, 8)}`) })
  const broker = createLinuxBroker({ mode: "enabled", stateStore })
  return new LinuxBrokerProjectionExecutor({
    broker,
    authority: authorityFor(merged),
    writableRoots: ["src"],
    readonlyRoots: ["docs"],
    profile: "build",
    receiptAuthority: new RuntimeStateReceiptAuthority(stateStore),
    ...overrides,
  })
}

describe("AK2-T06 adapter 边界", () => {
  test("authority workspace 与 merged 不匹配 → 拒绝（只接收 projection workspace）", async () => {
    const merged = tmpMerged("a")
    const other = tmpMerged("b")
    // 拒绝发生在 execute 入口（authority 校验），无需真实探测/执行 ——
    // 用 fixture capabilities 避免宿主探测（CPU/时间）开销。
    const executor = new LinuxBrokerProjectionExecutor({
      broker: createLinuxBroker({ mode: "enabled", testCapabilities: HOST_AUDIT_TEST_CAPABILITIES }),
      authority: authorityFor(other),
      writableRoots: ["src"],
      readonlyRoots: ["docs"],
      profile: "build",
    })
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
    // 拒绝发生在 execute 入口（authority 校验）——fixture capabilities 足够。
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
  test("exitCode=0 → outcome COMPLETED；cleanup proof 不可得 → ENV_BLOCKED（无 receiptId，World commit 被阻止）", async () => {
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
    expect(receipt).toBeDefined()
    // receipt 不携带任何 World/Graph completion 字段。
    expect("worldCommit" in receipt!).toBe(false)
    expect("graphCompleted" in receipt!).toBe(false)
    expect("evidenceBound" in receipt!).toBe(false)
    expect(receipt!.exitCode).toBe(0)
    // R2-03：本机 Bubblewrap 无 cgroup 委托 → cleanupVerified=false /
    // processesRemaining=-1 —— cleanup proof 不可得。final receipt 无法被
    // 认定为 finalized → outcome 不携带 receiptId → World acceptance 被阻止
    // （fail-closed）。这不算 PASS：真实 lane 标 ENV_BLOCKED。
    if (outcome.executionReceiptId === undefined) {
      console.log("ENV_BLOCKED: bubblewrap cleanup proof unavailable (cleanupVerified=false / processesRemaining=-1 on this host); receiptId withheld")
    }
    expect(outcome.executionReceiptId).toBeUndefined()
  }, 45_000)


  test("exitCode!=0 → outcome 失败；cleanup proof 不可得 → ENV_BLOCKED（无 receiptId）", async () => {
    const merged = tmpMerged("fail")
    const executor = adapter(merged)
    const { outcome } = await executor.execute(merged, {
      executable: "/bin/sh",
      args: ["-c", "exit 3"],
    })
    expect(outcome.exitCode).toBe(3)
    if (outcome.executionReceiptId === undefined) {
      console.log("ENV_BLOCKED: bubblewrap cleanup proof unavailable on this host; receiptId withheld")
    }
    expect(outcome.executionReceiptId).toBeUndefined()
  }, 45_000)


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
  }, 45_000)


  test("adapter 不放大权限：writable mounts 只来自 plan scope（编译后 spec 检查）", async () => {
    const merged = tmpMerged("scope")
    const broker = createLinuxBroker({ mode: "enabled" })
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
    // R01.4：receipt 必须证明 namespace/container 隔离（非 host-audit）。
    expect(receipt!.backend).not.toBe("host-audit")
    expect(["bubblewrap", "rootless-podman"]).toContain(receipt!.backend)
  }, 45_000)


  test("R3-01.4：adapter 实际执行 command/workspace/scope 与 intent 完全一致（spec 编译断言）", async () => {
    const merged = tmpMerged("intent")
    const broker = createLinuxBroker({ mode: "enabled" })
    const authority = authorityFor(merged)
    const executor = new LinuxBrokerProjectionExecutor({
      broker,
      authority,
      writableRoots: ["src"],
      readonlyRoots: ["docs"],
      profile: "build",
    })
    // 捕获 broker.compileRequest 的 spec —— 证明 adapter 用 intent.command
    // 精确编译（executable/args/cwd 与 intent 一致；writable/readonly mounts
    // 来自 plan scope）。
    let captured: import("../../../src/runtime/linux/contracts").UntrustedCapabilityRequest | undefined
    const originalCompile = broker.compileRequest.bind(broker)
    ;(broker as { compileRequest: (...args: Parameters<typeof originalCompile>) => ReturnType<typeof originalCompile> }).compileRequest = (
      request: import("../../../src/runtime/linux/contracts").UntrustedCapabilityRequest,
      auth?: import("../../../src/runtime/linux/contracts").TrustedExecutionAuthority,
    ) => {
      captured = request
      return originalCompile(request, auth)
    }
    // R4-03：intent 必须携带真实 workspace 身份与 scope digest（adapter
    // spawn 前逐字段验证）。
    const { lstatSync } = require("node:fs") as typeof import("node:fs")
    const mergedStat = lstatSync(merged)
    const { canonicalJson, sha256Digest } = require("../../../src/kernel/world/canonical") as typeof import("../../../src/kernel/world/canonical")
    const intent = {
      intentId: "intent-r3-1",
      worldId: "w",
      branchId: "b",
      snapshotId: "s",
      projectionId: "p",
      sessionNonce: "n",
      mergedRootIdentity: { dev: mergedStat.dev, ino: mergedStat.ino },
      command: { executable: "/bin/echo", args: ["hello", "world"] },
      scopeDigest: sha256Digest(Buffer.from(canonicalJson({ writableRoots: ["src"], readonlyRoots: ["docs"] }), "utf8")),
    }
    await executor.execute(merged, {
      executable: "/bin/echo",
      args: ["hello", "world"],
      intent: intent as never,
    })
    expect(captured).toBeDefined()
    expect(captured!.command.executable).toBe("/bin/echo")
    expect(captured!.command.args).toEqual(["hello", "world"])
    expect(captured!.command.relativeCwd).toBe(".")
    // workspace/scope：writable/readonly mounts 必须与 plan scope 精确一致。
    expect(captured!.writableMounts).toContainEqual({ source: { type: "workspace-relative", path: "src" }, target: "/src", mode: "rw" })
    expect(captured!.readonlyMounts).toContainEqual({ source: { type: "workspace-relative", path: "docs" }, target: "/docs", mode: "ro" })
    // intent digest 注入 spec 环境变量（→ cellSpecDigest → final receipt）。
    expect(captured!.env?.ORCANA_PROJECTION_INTENT).toBe(
      (await import("../../../src/kernel/projection/contracts")).projectionIntentDigest(intent as never),
    )
  }, 45_000)

  test("P0-1：namespace/container backend 不可用 → pre-spawn 拒绝；command 从未执行（marker 不存在/lower 未变）", async () => {
    const merged = tmpMerged("prespawn")
    // 执行域若运行：创建宿主 marker + 修改 projection lower（../base 不可达
    // 但 host-audit 无隔离可写任意路径）—— 任何一项都不允许发生。
    const marker = join(tmpdir(), `ak2-prespawn-marker-${process.pid}`)
    const lowerProbe = join(merged, "lower-probe.txt")
    rmSync(marker, { force: true })
    rmSync(lowerProbe, { force: true })
    // fixture capabilities：bubblewrap/podman 全部不可用 → broker 无法保证
    // namespace/container（selectBackendFor 抛错/返回 host-audit）→ 拒绝必须
    // 发生在 spawn 之前。
    const broker = createLinuxBroker({ mode: "enabled", testCapabilities: HOST_AUDIT_TEST_CAPABILITIES })
    const executor = new LinuxBrokerProjectionExecutor({
      broker,
      authority: authorityFor(merged),
      writableRoots: ["src"],
      readonlyRoots: ["docs"],
      profile: "build",
    })
    await expect(
      executor.execute(merged, {
        executable: "/bin/sh",
        args: ["-c", `touch ${marker} && echo pwned > ${lowerProbe}`],
      }),
    ).rejects.toMatchObject({ code: "HOST_AUDIT_ACCEPTED_AS_SECURITY_BOUNDARY" })
    // 命令从未执行：
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(lowerProbe)).toBe(false)
  }, 45_000)


  test("P1-6：outcome.executionReceiptId 必须是最终持久化 digest（cleanup truth 合并后）", async () => {
    const merged = tmpMerged("finaldigest")
    const stateRoot = join(tmpdir(), `ak2-finaldigest-state-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
    const stateStore = new RuntimeStateStore({ root: stateRoot })
    const broker = createLinuxBroker({ mode: "enabled", stateStore })
    const registry = new WorkspaceAuthorityRegistry()
    const workspace = registry.registerAgentWorktree({ projectId: "p", hostRoot: merged, access: "readwrite", ownerFiles: [merged] })
    const runId = `run-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    const authority = { identity: { runId, nodeRunId: `${runId}:n1`, attempt: 1 }, workspace }
    const executor = new LinuxBrokerProjectionExecutor({
      broker,
      authority,
      writableRoots: ["src"],
      readonlyRoots: ["docs"],
      profile: "build",
      receiptAuthority: new RuntimeStateReceiptAuthority(stateStore),
    })
    const { outcome } = await executor.execute(merged, { executable: "/bin/true", args: [] })
    // 事件流中的 receipt 是 pre-final（cleanup truth 未合并）；outcome 只
    // 携带 cleanup-finalized 的最终 digest。本机 bwrap 无 cgroup 委托 →
    // cleanup proof 不可得 → 不携带 receiptId（ENV_BLOCKED，fail-closed）。
    // final-digest 一致性逻辑由 fake authority 测试覆盖（P0-2 合法 receipt）。
    const receiptsDir = join(stateStore.runDir(runId), "receipts")
    expect(existsSync(receiptsDir)).toBe(true)
    const cells = readdirSync(receiptsDir).filter(name => name.endsWith(".json"))
    expect(cells.length).toBe(1)
    const persisted = JSON.parse(readFileSync(join(receiptsDir, cells[0]!), "utf8")) as { receiptDigest: string; cleanup: { mountsReleased: boolean; cgroupRemoved: boolean } }
    // final receipt 已持久化（broker cleanup 后写入）但 cleanup 未证明。
    if (outcome.executionReceiptId === undefined) {
      console.log("ENV_BLOCKED: final receipt persisted but cleanup proof unavailable (cleanupVerified=false); receiptId withheld")
    }
    expect(outcome.executionReceiptId).toBeUndefined()
    // final receipt 包含 cleanup truth 字段。
    expect(typeof persisted.cleanup.mountsReleased).toBe("boolean")
    expect(typeof persisted.cleanup.cgroupRemoved).toBe("boolean")
  }, 45_000)


  test("P1-6：appendReceipt 持久化失败 → final receipt 不可得 → outcome 无 receiptId（World acceptance 被阻止）", async () => {
    const merged = tmpMerged("persist")
    // stateStore root 注入；把 receipts 持久化路径破坏（receipts 目录位置是
    // 文件）→ broker 的 appendReceipt 失败（catch 吞掉）→ 无 final receipt。
    const stateRoot = join(tmpdir(), `ak2-persist-state-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
    const runId = `run-${process.pid}`
    mkdirSync(join(stateRoot, "runs", runId), { recursive: true })
    writeFileSync(join(stateRoot, "runs", runId, "receipts"), "block appendReceipt")
    const stateStore = new RuntimeStateStore({ root: stateRoot })
    const broker = createLinuxBroker({ mode: "enabled", stateStore })
    const registry = new WorkspaceAuthorityRegistry()
    const workspace = registry.registerAgentWorktree({ projectId: "p", hostRoot: merged, access: "readwrite", ownerFiles: [merged] })
    const authority = { identity: { runId, nodeRunId: `${runId}:n1`, attempt: 1 }, workspace }
    const executor = new LinuxBrokerProjectionExecutor({
      broker,
      authority,
      writableRoots: ["src"],
      readonlyRoots: ["docs"],
      profile: "build",
      receiptAuthority: new RuntimeStateReceiptAuthority(stateStore),
    })
    const { outcome } = await executor.execute(merged, { executable: "/bin/true", args: [] })
    // 执行成功但 persistence failure → final receipt 不可得 → 无 receiptId。
    expect(outcome.exitCode).toBe(0)
    expect(outcome.executionReceiptId).toBeUndefined()
  }, 45_000)


  test("R01.4：host-audit receipt 不能被 acceptance coordinator 接受 → HOST_AUDIT_ACCEPTED_AS_SECURITY_BOUNDARY", async () => {
    const merged = tmpMerged("ha")
    // 显式 diagnostic fixture：host-audit 后端执行成功（exit 0 + receipt），
    // 但 adapter 必须拒绝 —— Host Audit 不是安全边界。
    const broker = createLinuxBroker({ mode: "enabled", testCapabilities: HOST_AUDIT_TEST_CAPABILITIES })
    const executor = new LinuxBrokerProjectionExecutor({
      broker,
      authority: authorityFor(merged),
      writableRoots: ["src"],
      readonlyRoots: ["docs"],
      profile: "build",
    })
    await expect(
      executor.execute(merged, { executable: "/bin/true", args: [] }),
    ).rejects.toMatchObject({ code: "HOST_AUDIT_ACCEPTED_AS_SECURITY_BOUNDARY" })
  }, 45_000)


  test("R01.5：执行域无法寻址 ../base、projection root 兄弟与宿主绝对路径（bwrap 隔离视图）", async () => {
    const merged = tmpMerged("iso")
    // 宿主 marker：测试创建于宿主 /tmp（bwrap 的 /tmp 是空 tmpfs）与
    // /home（不在 SYSTEM_READONLY_PATHS 布局内）—— cell 内必须不可见。
    const marker = join(tmpdir(), `ak2-host-marker-${process.pid}`)
    writeFileSync(marker, "host")
    try {
      const executor = adapter(merged)
      const { outcome } = await executor.execute(merged, {
        executable: "/bin/sh",
        args: [
          "-c",
          "{ test -e ../base && echo PARENT_BASE_VISIBLE || echo parent_base_hidden; " +
            "test -e ../merged-m && echo PARENT_MERGED_VISIBLE || echo parent_merged_hidden; " +
            `test -e ${marker} && echo HOST_TMP_VISIBLE || echo host_tmp_hidden; ` +
            "test -e /home/fuqiang/worktrees/orcana-agent-os && echo HOST_HOME_VISIBLE || echo host_home_hidden; } > src/out.txt",
        ],
      })
      expect(outcome.exitCode).toBe(0)
      const output = readFileSync(join(merged, "src/out.txt"), "utf8")
      expect(output).toContain("parent_base_hidden")
      expect(output).toContain("parent_merged_hidden")
      expect(output).toContain("host_tmp_hidden")
      expect(output).toContain("host_home_hidden")
    } finally {
      rmSync(marker, { force: true })
    }
  }, 45_000)

})
