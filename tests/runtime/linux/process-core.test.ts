/** LNXF LF-2 acceptance: 统一进程核心.
 *
 *  Gates: DIRECT_LINUX_PROCESS_BYPASS / HOST_ENV_SECRET_LEAK /
 *  ORPHAN_PROCESS_AFTER_CANCEL / OUTPUT_LIMIT_BYPASS.
 */

import { describe, expect, test } from "bun:test"
import ts from "typescript"
import { platform } from "node:os"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { runSupervised, streamSupervised } from "../../../src/runtime/linux/process/supervisor"
import { countProcessGroup, killProcessGroup, terminateTree } from "../../../src/runtime/linux/process/termination"
import { createOutputLimiter, finalizeOutput, TRUNCATION_MARKER } from "../../../src/runtime/linux/process/output-limiter"
import { buildExplicitEnvironment, hostKeyDenied, environmentLeaksHostSecrets } from "../../../src/runtime/linux/environment"
import { bindSecrets, newSecretBinding } from "../../../src/runtime/linux/secrets"
import { createHostAuditBackend } from "../../../src/runtime/linux/backends/host-audit"
import { createLinuxBroker, testAuthorityFallback } from "../../../src/runtime/linux/broker"
import { compileCellSpec, compileCapabilityRequest } from "../../../src/runtime/linux/policy-compiler"
import { LinuxExecutionError } from "../../../src/runtime/linux/errors"
import type { ExecutionCellSpec } from "../../../src/runtime/linux/contracts"

const linuxOnly = platform() === "linux" ? test : test.skip
const LINUX_RUNTIME_DIRS = ["src/runtime/linux/backends/", "src/runtime/linux/process/"]

function baseSpec(overrides: Partial<ExecutionCellSpec> = {}): ExecutionCellSpec {
  return {
    schemaVersion: "1.0",
    identity: { cellId: "c1", runId: "r1", nodeRunId: "r1:n1", attempt: 1 },
    command: { executable: "/bin/true", args: [], cwd: "/tmp", stdin: "closed" },
    profile: "inspect",
    isolation: { minimum: "audit", preferredBackend: "host-audit", allowDegradation: true },
    filesystem: { readonlyMounts: [], writableMounts: [], tmpfsMounts: [], hiddenPaths: [], emptyHome: true },
    network: { mode: "none" },
    environment: { variables: {}, inheritHost: false, locale: "C.UTF-8", pathEntries: [] },
    secrets: [],
    resources: { memoryMaxBytes: 1024, pidsMax: 32, wallTimeMs: 10_000, stdoutMaxBytes: 64 * 1024, stderrMaxBytes: 64 * 1024, tmpfsMaxBytes: 1024 },
    cache: [],
    lifecycle: { killOnParentExit: true, cleanupOnExit: true, retainOnFailure: false, serviceMode: false },
    policyDigest: "",
    ...overrides,
  }
}

describe("LF-2: explicit environment", () => {
  test("child env never inherits host secrets", () => {
    const built = buildExplicitEnvironment({
      policy: { baseProfile: "minimal", allowedHostKeys: [], fixedValues: {}, requestedValues: {}, deniedKeys: [] },
      runId: "r1",
      nodeRunId: "r1:n1",
    })
    expect(built.ok).toBe(true)
    expect(built.env.HOME).toBe("/home/orcana")
    expect(built.env.ORCANA_SANDBOX).toBe("1")
    expect(built.env.ORCANA_RUN_ID).toBe("r1")
    // 宿主密钥永不进入子进程环境
    expect(environmentLeaksHostSecrets(built.env)).toEqual([])
    const leaked = environmentLeaksHostSecrets(built.env, [])
    expect(leaked).toEqual([])
  })

  test("host key allowlist copies explicitly allowed keys only", () => {
    process.env.ORCANA_LNXF_ALLOWED_PROBE = "visible"
    const built = buildExplicitEnvironment({
      policy: { baseProfile: "minimal", allowedHostKeys: ["ORCANA_LNXF_ALLOWED_PROBE"], fixedValues: {}, requestedValues: {}, deniedKeys: [] },
      runId: "r1",
      nodeRunId: "r1:n1",
    })
    expect(built.env.ORCANA_LNXF_ALLOWED_PROBE).toBe("visible")
    delete process.env.ORCANA_LNXF_ALLOWED_PROBE
  })

  test("denied patterns are rejected even when requested", () => {
    const built = buildExplicitEnvironment({
      policy: {
        baseProfile: "minimal",
        allowedHostKeys: [],
        fixedValues: {},
        requestedValues: { GITHUB_TOKEN: "should-not-leak", MY_TOKEN: "no", SAFE_KEY: "ok" },
        deniedKeys: ["SAFE_KEY"],
      },
      runId: "r1",
      nodeRunId: "r1:n1",
    })
    expect(built.env.GITHUB_TOKEN).toBeUndefined()
    expect(built.env.MY_TOKEN).toBeUndefined()
    expect(built.env.SAFE_KEY).toBeUndefined()
    expect(built.rejectedHostKeys).toContain("GITHUB_TOKEN")
    expect(built.rejectedHostKeys).toContain("MY_TOKEN")
    expect(built.rejectedHostKeys).toContain("SAFE_KEY")
  })

  test("hostKeyDenied matches wildcard patterns", () => {
    expect(hostKeyDenied("OPENAI_API_KEY")).toBe(true)
    expect(hostKeyDenied("AWS_ACCESS_KEY_ID")).toBe(true)
    expect(hostKeyDenied("DATABASE_URL")).toBe(true)
    expect(hostKeyDenied("PATH")).toBe(false)
    expect(hostKeyDenied("HOME")).toBe(false)
  })
})

describe("LF-2: output limiter", () => {
  test("caps stdout and marks truncation", () => {
    const limiter = createOutputLimiter({ stdoutMaxBytes: 10, stderrMaxBytes: 10 })
    const chunk = Buffer.from("0123456789ABCDEF")
    const kept = limiter.absorb("stdout", chunk)
    expect(kept.toString()).toBe("0123456789")
    expect(limiter.state.stdoutTruncated).toBe(true)
    expect(limiter.exceeded()).toBe(true)
    // 再吸收全部丢弃
    expect(limiter.absorb("stdout", chunk).length).toBe(0)
  })

  test("truncation marker appended on finalize", () => {
    const limiter = createOutputLimiter({ stdoutMaxBytes: 4, stderrMaxBytes: 4 })
    limiter.absorb("stdout", Buffer.from("abcdef"))
    expect(TRUNCATION_MARKER.length).toBeGreaterThan(0)
    expect(finalizeOutput(limiter.state, "stdout")).toBe(TRUNCATION_MARKER)
    expect(finalizeOutput(limiter.state, "stderr")).toBe("")
  })
})

describe("LF-2: process supervision (linux)", () => {
  linuxOnly("exits with code and captures output", async () => {
    const result = await runSupervised({
      executable: "/bin/sh",
      args: ["-c", "echo out; echo err >&2; exit 3"],
      cwd: "/tmp",
      env: { PATH: "/usr/bin:/bin", HOME: "/home/orcana" },
      limits: { stdoutMaxBytes: 1024, stderrMaxBytes: 1024 },
      wallTimeMs: 10_000,
    })
    expect(result.exitCode).toBe(3)
    expect(result.stdout.trim()).toBe("out")
    expect(result.stderr.trim()).toBe("err")
    expect(result.timedOut).toBe(false)
    expect(result.orphanProcesses).toBe(0)
  })

  linuxOnly("timeout terminates the process group", async () => {
    const result = await runSupervised({
      executable: "/bin/sh",
      args: ["-c", "sleep 30"],
      cwd: "/tmp",
      env: { PATH: "/usr/bin:/bin", HOME: "/home/orcana" },
      limits: { stdoutMaxBytes: 1024, stderrMaxBytes: 1024 },
      wallTimeMs: 500,
    })
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBe(null)
    // F4：超时终止后进程组归零（terminateTree 实测扫描值）
    expect(result.orphanProcesses).toBe(0)
  })

  linuxOnly("abort signal cancels and tree-kills the process group", async () => {
    const controller = new AbortController()
    let spawnedPid = 0
    const promise = runSupervised({
      executable: "/bin/sh",
      args: ["-c", "sleep 30"],
      cwd: "/tmp",
      env: { PATH: "/usr/bin:/bin", HOME: "/home/orcana" },
      limits: { stdoutMaxBytes: 1024, stderrMaxBytes: 1024 },
      wallTimeMs: 30_000,
      abortSignal: controller.signal,
      onSpawn: pid => { spawnedPid = pid },
    })
    await new Promise(r => setTimeout(r, 300))
    expect(spawnedPid).toBeGreaterThan(0)
    expect(countProcessGroup(spawnedPid)).toBeGreaterThanOrEqual(1)
    controller.abort()
    const result = await promise
    expect(result.cancelled).toBe(true)
    // F2（ABORT_IGNORED）：取消后进程组必须真实归零 —— 不只看事件流结束
    expect(countProcessGroup(spawnedPid)).toBe(0)
    // F4（ORPHAN_PROCESS）：取消路径的残留值必须真实上报（terminateTree 实测，非硬编码 0）
    expect(result.orphanProcesses).toBe(0)
  })

  linuxOnly("abort kills nested grandchildren (subprocess-level cancel)", async () => {
    const controller = new AbortController()
    let spawnedPid = 0
    const promise = runSupervised({
      executable: "/bin/sh",
      args: ["-c", `sh -c "sleep 30 & sleep 30 & wait" & wait`],
      cwd: "/tmp",
      env: { PATH: "/usr/bin:/bin", HOME: "/home/orcana" },
      limits: { stdoutMaxBytes: 1024, stderrMaxBytes: 1024 },
      wallTimeMs: 30_000,
      abortSignal: controller.signal,
      onSpawn: pid => { spawnedPid = pid },
    })
    await new Promise(r => setTimeout(r, 300))
    expect(spawnedPid).toBeGreaterThan(0)
    // 进程树就绪：外层 sh + 内层 sh + 2 个 sleep（同组，未 setsid）
    expect(countProcessGroup(spawnedPid)).toBeGreaterThanOrEqual(3)
    controller.abort()
    const result = await promise
    expect(result.cancelled).toBe(true)
    // 嵌套子进程也必须随组清除 —— 无 ABORT_IGNORED 场景
    expect(countProcessGroup(spawnedPid)).toBe(0)
  })

  linuxOnly("output limit is hit on large output", async () => {
    const result = await runSupervised({
      executable: "/bin/sh",
      args: ["-c", "yes x | head -c 100000"],
      cwd: "/tmp",
      env: { PATH: "/usr/bin:/bin", HOME: "/home/orcana" },
      limits: { stdoutMaxBytes: 1024, stderrMaxBytes: 1024 },
      wallTimeMs: 10_000,
    })
    expect(result.outputLimitHit).toBe(true)
    expect(result.stdout.length).toBeLessThanOrEqual(1024 + TRUNCATION_MARKER.length)
  })

  linuxOnly("background daemon staying in the group is detected as orphan", async () => {
    const result = await runSupervised({
      // 后台进程逃逸父链但留在进程组（未 setsid）→ close 后组扫描必须数到。
      // setsid 级逃逸（离组）不在进程组扫描内 —— 由 cgroup 树级 kill 兜底
      // （host-audit 无 cgroup，非安全边界，ADR-L4）。
      executable: "/bin/sh",
      args: ["-c", "sleep 2 & exit 0"],
      cwd: "/tmp",
      env: { PATH: "/usr/bin:/bin", HOME: "/home/orcana" },
      limits: { stdoutMaxBytes: 1024, stderrMaxBytes: 1024 },
      wallTimeMs: 10_000,
      detectDaemon: true,
    })
    expect(result.exitCode).toBe(0)
    // F4（ORPHAN_PROCESS）：残留必须被实测报告（不能假 0）
    expect(result.orphanProcesses).toBeGreaterThanOrEqual(1)
  })

  linuxOnly("terminateTree kills the whole group", async () => {
    const { spawn } = await import("node:child_process")
    const proc = spawn("/bin/sh", ["-c", "sleep 10 & sleep 10 & wait"], { detached: true, stdio: "ignore" })
    await new Promise(r => setTimeout(r, 300))
    expect(countProcessGroup(proc.pid ?? 0)).toBeGreaterThanOrEqual(1)
    const report = terminateTree(proc.pid ?? 0, { graceMs: 200, attempts: 2 })
    await new Promise(r => setTimeout(r, 200))
    expect(countProcessGroup(proc.pid ?? 0)).toBe(0)
    expect(report.processesRemaining).toBe(0)
  })
})

describe("LF-2: WRONG_PROCESS_KILL (F7, pid<=0)", () => {
  test("killProcessGroup refuses pid<=0 signal operations", () => {
    // pid=0：POSIX 语义 signal 调用方自身进程组（killpg(0)）；
    // pid<0：-pid 反转后指向无关单进程。防护若回归，以下调用会杀死
    // bun test 自身（process.kill(-0) / kill(own pid)）—— 测试即金丝雀。
    expect(killProcessGroup(0, "SIGTERM").processesRemaining).toBe(0)
    expect(killProcessGroup(-1, "SIGTERM").processesRemaining).toBe(0)
    expect(killProcessGroup(-process.pid, "SIGKILL").processesRemaining).toBe(0)
  })

  test("terminateTree refuses pid<=0 (no kill escalation loop)", () => {
    expect(terminateTree(0).processesRemaining).toBe(0)
    expect(terminateTree(-process.pid).processesRemaining).toBe(0)
    expect(terminateTree(Number.NaN).processesRemaining).toBe(0)
  })

  test("countProcessGroup returns 0 for pid<=0", () => {
    expect(countProcessGroup(0)).toBe(0)
    expect(countProcessGroup(-5)).toBe(0)
  })

  test("valid pid still kills the group (guard does not break normal path)", async () => {
    const { spawn } = await import("node:child_process")
    const proc = spawn("/bin/sh", ["-c", "sleep 10"], { detached: true, stdio: "ignore" })
    await new Promise(r => setTimeout(r, 200))
    const pid = proc.pid ?? 0
    expect(pid).toBeGreaterThan(0)
    expect(countProcessGroup(pid)).toBeGreaterThanOrEqual(1)
    expect(killProcessGroup(pid, "SIGKILL").processesRemaining).toBe(0)
  })
})

describe("LF-2: launcher handshake (LR2-0F)", () => {
  const { mkdtempSync, writeFileSync, existsSync } = require("node:fs") as typeof import("node:fs")
  const { tmpdir } = require("node:os") as typeof import("node:os")
  const { join } = require("node:path") as typeof import("node:path")

  linuxOnly("attach rejection blocks the target before exec (no instructions run)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lh-block-"))
    const marker = join(dir, "executed.txt")
    // onSpawn 返回 false（attach 未确认）→ launcher 阻塞在 read，
    // 目标（写 marker 的命令）不得执行。
    const controller = new AbortController()
    const promise = runSupervised({
      executable: "/bin/sh",
      args: ["-c", `echo EXECUTED > ${marker}`],
      cwd: "/tmp",
      env: { PATH: "/usr/bin:/bin", HOME: "/home/orcana" },
      limits: { stdoutMaxBytes: 1024, stderrMaxBytes: 1024 },
      wallTimeMs: 5000,
      abortSignal: controller.signal,
      launcherHandshake: true,
      onSpawn: () => false,
    })
    await new Promise(r => setTimeout(r, 400))
    expect(existsSync(marker)).toBe(false) // 目标从未执行
    controller.abort()
    const result = await promise
    expect(result.cancelled).toBe(true)
    expect(existsSync(marker)).toBe(false)
  })

  linuxOnly("handshake releases the target after attach confirmation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lh-rel-"))
    const marker = join(dir, "executed.txt")
    const result = await runSupervised({
      executable: "/bin/sh",
      args: ["-c", `echo EXECUTED > ${marker}; echo out; exit 7`],
      cwd: "/tmp",
      env: { PATH: "/usr/bin:/bin", HOME: "/home/orcana" },
      limits: { stdoutMaxBytes: 1024, stderrMaxBytes: 1024 },
      wallTimeMs: 5000,
      launcherHandshake: true,
      onSpawn: () => true, // attach 确认 → 释放
    })
    expect(result.exitCode).toBe(7)
    expect(result.stdout.trim()).toBe("out")
    expect(existsSync(marker)).toBe(true)
    // exec 替换进程自身 —— PID 不变（launcher 语义）。
    expect(result.orphanProcesses).toBe(0)
  })

  linuxOnly("handshake preserves seccomp FD slot and stdin semantics", async () => {
    // launcher 模式下 stdin 为 pipe（释放令牌通道）；释放后 end → 目标
    // stdin EOF（≈ closed）。目标读 stdin 应立即 EOF。
    const result = await runSupervised({
      executable: "/bin/sh",
      args: ["-c", "read -r line && echo got:$line || echo eof"],
      cwd: "/tmp",
      env: { PATH: "/usr/bin:/bin", HOME: "/home/orcana" },
      limits: { stdoutMaxBytes: 1024, stderrMaxBytes: 1024 },
      wallTimeMs: 5000,
      launcherHandshake: true,
      onSpawn: () => true,
    })
    expect(result.stdout.trim()).toBe("eof")
  })
})

describe("LF-2: terminateTree bounded budget (LR2-0J)", () => {
  /** 组内唯一、SIGTERM 显式忽略的进程（系统 node 注册 handler；实测 WSL
   *  dash 的 trap '' TERM 不可靠——信号后仍退出；bun 的 process.execPath
   *  可能指向 Windows 兼容层 bun.exe，WSL interop 下 /proc 不可见）。
   *  必须等 stdout "ready" 再发信号：高负载下 node 启动慢，进程已 fork 但
   *  handler 尚未注册时 SIGTERM 会走默认退出（预算耗尽路径就不会被触发）。 */
  async function spawnIgnoringTerm(): Promise<{ proc: import("node:child_process").ChildProcess; pid: number }> {
    const { spawn } = await import("node:child_process")
    return new Promise((resolve, reject) => {
      const proc = spawn("node", ["-e", 'process.on("SIGTERM",()=>{}); console.log("ready"); setInterval(()=>{},1000)'], {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      })
      proc.stdout?.once("data", () => resolve({ proc, pid: proc.pid ?? 0 }))
      proc.once("error", reject)
    })
  }

  linuxOnly("budget exhaustion reports the real remaining count (never fake 0)", async () => {
    const { proc, pid } = await spawnIgnoringTerm()
    expect(countProcessGroup(pid)).toBeGreaterThanOrEqual(1)
    // 超短预算（1ms）：SIGTERM（被忽略）发出后第一次 /proc 扫描必然已
    // 超预算 → 立即如实返回当前扫描值（进程仍存活，≥1），不会升级 SIGKILL。
    // 原实现（`remaining <= 0` 判干净 + 无预算）在高负载 WSL /proc 扫描下
    // 可同步阻塞 10s+（触发上层 wall-time 超时 → broker 事务 finally 不执行
    // → Isolation Lock 泄漏）。这里验证有界 + 不假 0。
    const startedAt = Date.now()
    const report = terminateTree(pid, { graceMs: 100, attempts: 1, budgetMs: 1 })
    const elapsed = Date.now() - startedAt
    expect(elapsed).toBeLessThan(3000)
    // 预算耗尽返回的是"当下实测值"：SIGKILL 未发出，进程必须仍存活。
    expect(report.processesRemaining).toBeGreaterThanOrEqual(1)
    // 清场：正常预算下必须归零。
    const clean = terminateTree(pid, { graceMs: 200, attempts: 3, budgetMs: 5000 })
    await new Promise(r => setTimeout(r, 200))
    expect(countProcessGroup(pid)).toBe(0)
    expect(clean.processesRemaining).toBe(0)
  })

  linuxOnly("bounded budget shortens escalation — SIGKILL still cleans the group", async () => {
    // SIGTERM 被忽略的组：小预算（150ms）内走完 grace → 升级 SIGKILL
    // → 归零。返回 0 是如实值（SIGKILL 成功），不是假干净。
    const { proc, pid } = await spawnIgnoringTerm()
    expect(countProcessGroup(pid)).toBeGreaterThanOrEqual(1)
    const startedAt = Date.now()
    const report = terminateTree(pid, { graceMs: 100, attempts: 1, budgetMs: 150 })
    const elapsed = Date.now() - startedAt
    // 有界性：预算 150ms + 至多 2 次 /proc 扫描（WSL 高负载下单次扫描
    // 可能数百 ms）—— 远低于上层 wall-time 超时（5s）的 3s 上界。
    expect(elapsed).toBeLessThan(3000)
    await new Promise(r => setTimeout(r, 200))
    expect(countProcessGroup(pid)).toBe(0)
    expect(report.processesRemaining).toBe(0)
  })

  linuxOnly("budget only shortens the escalation — full budget still kills", async () => {
    // SIGTERM 被忽略的组：完整预算下 SIGKILL 升级必须归零。
    const { proc, pid } = await spawnIgnoringTerm()
    expect(countProcessGroup(pid)).toBeGreaterThanOrEqual(1)
    const report = terminateTree(pid, { graceMs: 100, attempts: 1 })
    await new Promise(r => setTimeout(r, 200))
    expect(countProcessGroup(pid)).toBe(0)
    expect(report.processesRemaining).toBe(0)
  })
})

describe("LF-2: host audit backend", () => {
  linuxOnly("executes and produces a receipt", async () => {
    const backend = createHostAuditBackend()
    const spec = baseSpec({ command: { executable: "/bin/true", args: [], cwd: "/tmp", stdin: "closed" } })
    expect(backend.validateSpec(spec)).toEqual([])
    const events: string[] = []
    const { probeLinuxCapabilities } = await import("../../../src/runtime/linux/capability-probe")
    const caps = probeLinuxCapabilities()
    for await (const event of backend.run(spec, { capabilities: caps })) {
      events.push(event.type)
    }
    expect(events).toContain("cell.status")
    expect(events).toContain("cell.exit")
    expect(events).toContain("cell.receipt")
    const receiptEvent = events.indexOf("cell.receipt")
    expect(receiptEvent).toBeGreaterThan(-1)
  })

  linuxOnly("rejects minimum=namespace spec", () => {
    const backend = createHostAuditBackend()
    const spec = baseSpec({ isolation: { minimum: "namespace", preferredBackend: "bubblewrap", allowDegradation: false } })
    expect(backend.validateSpec(spec).length).toBeGreaterThan(0)
  })
})

describe("LF-2: broker execution", () => {
  linuxOnly("enabled mode executes via host-audit", async () => {
    const broker = createLinuxBroker({ mode: "enabled" })
    const spec = baseSpec()
    const receipts: unknown[] = []
    for await (const event of broker.execute(spec)) {
      if (event.type === "cell.receipt") receipts.push(event.receipt)
    }
    expect(receipts).toHaveLength(1)
  })

  linuxOnly("shadow mode does not execute", async () => {
    const broker = createLinuxBroker({ mode: "shadow" })
    const spec = baseSpec()
    const events: string[] = []
    for await (const event of broker.execute(spec)) {
      events.push(event.type)
    }
    expect(events).toEqual([])
  })

  linuxOnly("strict spec without backend availability fails closed", () => {
    const broker = createLinuxBroker({ mode: "enabled" })
    const spec = baseSpec({ profile: "untrusted", isolation: { minimum: "container", preferredBackend: "podman", allowDegradation: false } })
    // 编译（结构校验）通过；后端选择（执行路径）fail-closed 拒绝
    expect(broker.compileSpec(spec).policyDigest.length).toBe(64)
    expect(() => broker.selectBackendFor(spec)).toThrow(LinuxExecutionError)
  })

  linuxOnly("C1: every strict profile fails closed on degradation (no silent downgrade)", () => {
    // 全部 strict profile（allowDegradation=false）：最小隔离不可满足时
    // 必须抛错，绝不静默降级到 host-audit。本环境 bwrap/podman 均不可用，
    // container minimum 无后端可满足 —— 断言确定。
    for (const profile of ["test", "dependency", "service", "untrusted", "evolution"] as const) {
      const broker = createLinuxBroker({ mode: "enabled" })
      const spec = baseSpec({ profile, isolation: { minimum: "container", preferredBackend: "podman", allowDegradation: false } })
      expect(broker.compileSpec(spec).policyDigest.length).toBe(64)
      expect(() => broker.selectBackendFor(spec)).toThrow(LinuxExecutionError)
    }
  })

  test("C1: strict profile rejects allowDegradation=true at compile layer", () => {
    for (const profile of ["test", "dependency", "service", "untrusted", "evolution"] as const) {
      const spec = baseSpec({ profile, isolation: { minimum: "container", preferredBackend: "podman", allowDegradation: true } })
      const compiled = compileCellSpec(spec)
      expect(compiled.ok).toBe(false)
      if (!compiled.ok) {
        expect(compiled.errors.some(e => e.includes("DEGRADATION_NOT_ALLOWED_BY_PROFILE"))).toBe(true)
      }
    }
  })

  linuxOnly("C1: capability request cannot widen strict profile isolation", () => {
    const authority = testAuthorityFallback(process.cwd())
    for (const profile of ["test", "dependency", "service", "untrusted", "evolution"] as const) {
      const result = compileCapabilityRequest(
        { command: { executable: "/bin/true", args: [], relativeCwd: ".", stdin: "closed" }, profile, network: { mode: "none" }, env: {}, allowedHostKeys: [] },
        authority,
      )
      expect(result.ok).toBe(true)
      // 不可信请求层无法覆盖 allowDegradation —— isolation 只来自 Profile 默认值
      if (result.ok) expect(result.spec.isolation.allowDegradation).toBe(false)
    }
    const inspect = compileCapabilityRequest(
      { command: { executable: "/bin/true", args: [], relativeCwd: ".", stdin: "closed" }, profile: "inspect", network: { mode: "none" }, env: {}, allowedHostKeys: [] },
      authority,
    )
    expect(inspect.ok).toBe(true)
    if (inspect.ok) expect(inspect.spec.isolation.allowDegradation).toBe(true)
  })

  linuxOnly("C1: non-strict degradation is explicit in receipt, not silent", async () => {
    const broker = createLinuxBroker({ mode: "enabled" })
    // build 允许降级：bwrap 不可用 → host-audit，但原因必须显式入 Receipt
    // （STRICT_PROFILE_DEGRADED 只禁静默降级 —— 显式降级需带 degradationReasons）
    const spec = baseSpec({ profile: "build", isolation: { minimum: "namespace", preferredBackend: "bubblewrap", allowDegradation: true } })
    const receipts: unknown[] = []
    for await (const event of broker.execute(spec)) {
      if (event.type === "cell.receipt") receipts.push(event.receipt)
    }
    const receipt = receipts[0] as { degradationReasons?: string[] } | undefined
    expect(receipt).toBeDefined()
    expect(receipt!.degradationReasons?.some(r => r.includes("Host Audit"))).toBe(true)
  })
})

describe("LF-2: secrets", () => {
  test("sealed-file delivery writes 0600 and cleans up", () => {
    const binding = newSecretBinding({ purpose: "registry", delivery: "sealed-file", target: "/run/secrets/reg", expiresAt: Date.now() + 60_000 })
    const result = bindSecrets({ bindings: [binding], values: { [binding.id]: "s3cr3t" }, secretsRoot: join("/tmp", `lnxf-secrets-test-${process.pid}`) })
    expect(result.ok).toBe(true)
    expect(result.bound[0]?.deliveryTarget).toBeTruthy()
    expect(result.envInjections).toEqual({})
    result.cleanup()
  })

  test("environment delivery injects into env", () => {
    const binding = newSecretBinding({ purpose: "auth", delivery: "environment", target: "ORCANA_AUTH_SECRET", expiresAt: Date.now() + 60_000 })
    const result = bindSecrets({ bindings: [binding], values: { [binding.id]: "x" } })
    expect(result.envInjections.ORCANA_AUTH_SECRET).toBe("x")
    result.cleanup()
  })

  test("expired binding is rejected", () => {
    const binding = newSecretBinding({ purpose: "auth", delivery: "sealed-file", expiresAt: Date.now() - 1000 })
    const result = bindSecrets({ bindings: [binding], values: { [binding.id]: "x" } })
    expect(result.ok).toBe(false)
  })
})

describe("LF-2: static gate — DIRECT_LINUX_PROCESS_BYPASS (AST)", () => {
  // R1: 旁路必须为 0 —— 允许列表只含统一入口与监督器（LR2-0C 单一事实源：
  // config/runtime-process-bypass-allowlist.json，scripts/check-process-bypass.ts
  // 与本节共用）：
  //  - src/runtime/linux/**     Linux Process Supervisor（唯一真实后端）
  //  - process-executor.ts      跨平台统一执行入口（Windows legacy）
  //  - legacy-process.ts        R1.2 暂存区（sync/长期进程，待迁移，显式标注）
  //  - tools/process.ts         terminateTree 的 Windows taskkill 辅助
  const ALLOWLIST = (JSON.parse(
    readFileSync(join(process.cwd(), "config", "runtime-process-bypass-allowlist.json"), "utf8"),
  ) as { allowlist: string[] }).allowlist
  const PROCESS_NAMES = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])

  interface SpawnSite { file: string; line: number; kind: string }

  function scanDirectProcessCalls(): SpawnSite[] {
    const sites: SpawnSite[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
          const rel = full.slice(process.cwd().length + 1).split("\\").join("/")
          const source = readFileSync(full, "utf8")
          const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
          const importedNames = new Set<string>()
          let childProcessNamespace: string | undefined
          for (const statement of sf.statements) {
            if (!ts.isImportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue
            const mod = statement.moduleSpecifier.text
            if (mod === "node:child_process") {
              const clause = statement.importClause
              if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
                childProcessNamespace = clause.namedBindings.name.text
              } else if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
                for (const el of clause.namedBindings.elements) importedNames.add(el.name.text)
              }
            }
          }
          const fileHits: SpawnSite[] = []
          const visit = (node: ts.Node): void => {
            if (ts.isCallExpression(node)) {
              const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
              if (ts.isIdentifier(node.expression)) {
                if (importedNames.has(node.expression.text)) fileHits.push({ file: rel, line: line + 1, kind: node.expression.text })
              } else if (ts.isPropertyAccessExpression(node.expression)) {
                const name = node.expression.name.text
                const obj = node.expression.expression
                if (childProcessNamespace && ts.isIdentifier(obj) && obj.text === childProcessNamespace && PROCESS_NAMES.has(name)) {
                  fileHits.push({ file: rel, line: line + 1, kind: `child_process.${name}` })
                }
                if (name === "spawn" && ts.isIdentifier(obj) && obj.text === "Bun") {
                  fileHits.push({ file: rel, line: line + 1, kind: "Bun.spawn" })
                }
                if (name === "Command" && ts.isIdentifier(obj) && obj.text === "Deno") {
                  fileHits.push({ file: rel, line: line + 1, kind: "Deno.Command" })
                }
              }
            }
            if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "shell") {
              const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
              const valueText = node.initializer.getText(sf)
              if (valueText === "true") fileHits.push({ file: rel, line: line + 1, kind: "shell:true" })
            }
            ts.forEachChild(node, visit)
          }
          visit(sf)
          sites.push(...fileHits)
        }
      }
    }
    walk(join(process.cwd(), "src"))
    return sites
  }

  test("direct child_process / Bun.spawn / Deno.Command / shell:true outside allowlist = 0", () => {
    const sites = scanDirectProcessCalls()
    const outside = sites.filter(s => !ALLOWLIST.some(a => s.file === a || s.file.startsWith(a + "/")))
    expect(outside).toEqual([])
  })

  test("allowlist modules remain the only direct process entries (total audited)", () => {
    // 允许列表内的调用不得消失 —— 防止"删掉入口"式假绿。
    const sites = scanDirectProcessCalls()
    const executorSites = sites.filter(s => s.file.startsWith("src/runtime/process-executor") || s.file.startsWith("src/runtime/legacy-process"))
    expect(executorSites.length).toBeGreaterThan(0)
  })
})

describe("LNXF-R2 E1.8: static gate — HOST_PROCESS_BYPASS via legacy-process (AST)", () => {
  // E1：legacy 包装层（spawnLegacy/spawnSyncLegacy/execShellLegacy 及本地别名）
  // 的调用点必须显式登记暂存区；未登记 = HOST_PROCESS_BYPASS（绕过统一
  // 入口的宿主执行）。登记项各带收紧措施与迁移 deadline（PR-13/14）。
  const LEGACY_STAGING: Record<string, string> = {
    "src/agent/journal.ts": "E1.1: command 规则默认禁用 + opt-in 最小 env（迁 Executor）",
    "src/ripple/astgrep-provider.ts": "E1.5: 参数数组 + 最小 env（迁 Executor）",
    "src/tools/service.ts": "E1.2: taskkill/停止路径保留 legacy（主 spawn 已迁 Service Cell）",
    "src/workflow/agents/worktree.ts": "E1.6: args 数组无注入（git Broker 化 PR-13）",
    "src/verification/collector.ts": "E1.7: 死代码（无生产调用方，待删除/迁移）",
    // LNXF-GATE-02：mcp/lsp 已迁移 ServiceCell（不再导入 legacy-process）——
    // 若将来重新引入 legacy-process 调用，必须回到本登记表。
  }

  interface LegacySite { file: string; line: number; kind: string }

  function scanLegacyProcessCalls(): LegacySite[] {
    const sites: LegacySite[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
          const rel = full.slice(process.cwd().length + 1).split("\\").join("/")
          const source = readFileSync(full, "utf8")
          const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
          const legacyNames = new Set<string>() // 直接导入的 legacy 函数名
          const aliases = new Map<string, string>() // 本地别名 const spawn = spawnLegacy
          for (const statement of sf.statements) {
            if (ts.isImportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
              const mod = statement.moduleSpecifier.text
              if (!mod.endsWith("/legacy-process") && mod !== "legacy-process") continue
              const clause = statement.importClause
              if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
                for (const el of clause.namedBindings.elements) legacyNames.add(el.name.text)
              }
            }
            if (ts.isVariableStatement(statement)) {
              for (const decl of statement.declarationList.declarations) {
                if (ts.isIdentifier(decl.name) && decl.initializer && ts.isIdentifier(decl.initializer)) {
                  if (legacyNames.has(decl.initializer.text)) aliases.set(decl.name.text, decl.initializer.text)
                }
              }
            }
          }
          if (legacyNames.size === 0) continue
          const fileHits: LegacySite[] = []
          const visit = (node: ts.Node): void => {
            if (ts.isCallExpression(node)) {
              const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
              if (ts.isIdentifier(node.expression)) {
                const name = node.expression.text
                if (legacyNames.has(name)) fileHits.push({ file: rel, line: line + 1, kind: name })
                else if (aliases.has(name)) fileHits.push({ file: rel, line: line + 1, kind: `${name}(=${aliases.get(name)})` })
              }
            }
            ts.forEachChild(node, visit)
          }
          visit(sf)
          sites.push(...fileHits)
        }
      }
    }
    walk(join(process.cwd(), "src"))
    return sites
  }

  test("legacy-process 调用点全部显式登记（HOST_PROCESS_BYPASS = 0）", () => {
    const sites = scanLegacyProcessCalls()
    const unregistered = sites.filter(s => !(s.file in LEGACY_STAGING))
    expect(unregistered).toEqual([])
  })

  test("暂存登记保持有效（防删入口式假绿）", () => {
    const sites = scanLegacyProcessCalls()
    for (const file of Object.keys(LEGACY_STAGING)) {
      expect(sites.some(s => s.file === file), `staging entry missing: ${file}`).toBe(true)
    }
  })
})

describe("PR-2: receipt reaches ProcessExecutor consumers (no longer dropped)", () => {
  linuxOnly("collectProcessRun carries a real receipt with self digest", async () => {
    const { collectProcessRun, executeProcess } = await import("../../../src/runtime/process-executor")
    const { setExecutionAuthority, runWithRuntimeExecutionContext, createRuntimeExecutionContext } = await import("../../../src/runtime/execution-context")
    const run = () => runWithRuntimeExecutionContext(createRuntimeExecutionContext(), async () => {
      setExecutionAuthority({
        identity: { runId: `run-rc-${process.pid}`, nodeRunId: `run-rc-${process.pid}:n1`, attempt: 1 },
        workspace: { workspaceId: "ws_test", projectId: "test", hostRoot: process.cwd(), kind: "system", access: "readwrite", physicalWorkspaceKey: "wp_test", ownerFiles: [] },
      })
      return collectProcessRun({ command: "/bin/true", args: [], timeoutMs: 10_000 })
    })
    const outcome = await run()
    expect(outcome.receipt).toBeDefined()
    expect(outcome.receipt!.backend).toBe("host-audit")
    expect(outcome.receipt!.receiptDigest.length).toBe(64)
    // durationMs 来自真实执行（不是 0 推定值）
    expect(outcome.receipt!.durationMs).toBeGreaterThanOrEqual(0)
    expect(outcome.receipt!.finishedAt).toBeGreaterThan(outcome.receipt!.startedAt)

    // executeProcess 流式事件同样透传 receipt（不丢弃）
    const events: Array<{ type: string; [k: string]: unknown }> = []
    await runWithRuntimeExecutionContext(createRuntimeExecutionContext(), async () => {
      setExecutionAuthority({
        identity: { runId: `run-rc2-${process.pid}`, nodeRunId: `run-rc2-${process.pid}:n1`, attempt: 1 },
        workspace: { workspaceId: "ws_test", projectId: "test", hostRoot: process.cwd(), kind: "system", access: "readwrite", physicalWorkspaceKey: "wp_test", ownerFiles: [] },
      })
      for await (const e of executeProcess({ command: "/bin/true", args: [], timeoutMs: 10_000 })) {
        events.push(e as unknown as { type: string; [k: string]: unknown })
      }
    })
    expect(events.some(e => e.type === "receipt")).toBe(true)
  })
})

describe("PR-3: output limit kills the process (hard limit)", () => {
  linuxOnly("infinite output is terminated well before wall timeout", async () => {
    const startedAt = Date.now()
    const result = await runSupervised({
      executable: "/bin/sh",
      args: ["-c", "yes x"],
      cwd: "/tmp",
      env: { PATH: "/usr/bin:/bin", HOME: "/home/orcana" },
      limits: { stdoutMaxBytes: 1024, stderrMaxBytes: 1024 },
      wallTimeMs: 60_000,
    })
    const elapsed = Date.now() - startedAt
    // PR-3：超限即杀 —— 进程被终止而非跑满 wall timeout
    expect(result.outputLimitHit).toBe(true)
    expect(elapsed).toBeLessThan(10_000)
    // 截断数据总量 ≤ 上限 + 标记
    expect(result.stdout.length).toBeLessThanOrEqual(1024 + TRUNCATION_MARKER.length + 64)
    expect(result.orphanProcesses).toBe(0)
  })

  linuxOnly("streamSupervised yields only truncated data", async () => {
    let received = 0
    let hit = false
    for await (const event of streamSupervised({
      executable: "/bin/sh",
      args: ["-c", "yes x"],
      cwd: "/tmp",
      env: { PATH: "/usr/bin:/bin", HOME: "/home/orcana" },
      limits: { stdoutMaxBytes: 2048, stderrMaxBytes: 2048 },
      wallTimeMs: 60_000,
      onOutput: (stream, data) => { if (stream === "stdout") received += data.length },
    })) {
      if (event.type === "exit") hit = event.result.outputLimitHit
    }
    expect(hit).toBe(true)
    // 回调收到的数据在入队前已截断（≤ 上限）
    expect(received).toBeLessThanOrEqual(2048)
  })
})

describe("R2 PR-9: execution identity only from authority", () => {
  linuxOnly("authority identity reaches the compiled spec (no request identity fields)", async () => {
    const { executeProcess } = await import("../../../src/runtime/process-executor")
    const { setExecutionAuthority, runWithRuntimeExecutionContext, createRuntimeExecutionContext } = await import("../../../src/runtime/execution-context")
    const events: Array<{ type: string; [k: string]: unknown }> = []
    const run = () => runWithRuntimeExecutionContext(createRuntimeExecutionContext(), async () => {
      setExecutionAuthority({
        identity: { runId: "run-test-42", nodeRunId: "run-test-42:n3", attempt: 3, agentId: "agent-x" },
        workspace: { workspaceId: "ws_test", projectId: "test", hostRoot: process.cwd(), kind: "system", access: "readwrite", physicalWorkspaceKey: "wp_test", ownerFiles: [] },
      })
      for await (const e of executeProcess({ command: "/bin/true", args: [], timeoutMs: 10_000 })) {
        events.push(e as unknown as { type: string; [k: string]: unknown })
      }
    })
    await run()
    const receipt = events.find(e => e.type === "receipt") as { receipt: { runId: string; nodeRunId: string; agentId?: string; attempt: number } } | undefined
    expect(receipt).toBeDefined()
    expect(receipt!.receipt.runId).toBe("run-test-42")
    expect(receipt!.receipt.nodeRunId).toBe("run-test-42:n3")
    expect(receipt!.receipt.agentId).toBe("agent-x")
    expect(receipt!.receipt.attempt).toBe(3)
  })

  linuxOnly("no authority fails closed (enabled broker)", async () => {
    const { executeProcess } = await import("../../../src/runtime/process-executor")
    const { setExecutionAuthority } = await import("../../../src/runtime/execution-context")
    // 清理可能残留的 legacy 上下文权威（测试隔离）。
    setExecutionAuthority(undefined)
    let caught: unknown
    try {
      const events: Array<{ type: string; [k: string]: unknown }> = []
      for await (const e of executeProcess({ command: "/bin/true", args: [], timeoutMs: 10_000 })) {
        events.push(e as unknown as { type: string; [k: string]: unknown })
      }
    } catch (error) {
      caught = error
    }
    expect(String(caught)).toMatch(/trusted execution authority/i)
  })

  linuxOnly("authority context identity is injected from runtime scope", async () => {
    const { executeProcess } = await import("../../../src/runtime/process-executor")
    const { setExecutionAuthority, runWithRuntimeExecutionContext, createRuntimeExecutionContext } = await import("../../../src/runtime/execution-context")
    const events: Array<{ type: string; [k: string]: unknown }> = []
    await runWithRuntimeExecutionContext(createRuntimeExecutionContext(), async () => {
      setExecutionAuthority({
        identity: { runId: "ctx-run-1", nodeRunId: "ctx-run-1:n1", attempt: 1, agentId: "ctx-agent" },
        workspace: { workspaceId: "ws_test", projectId: "test", hostRoot: process.cwd(), kind: "system", access: "readwrite", physicalWorkspaceKey: "wp_test", ownerFiles: [] },
      })
      for await (const e of executeProcess({ command: "/bin/true", args: [], timeoutMs: 10_000 })) {
        events.push(e as unknown as { type: string; [k: string]: unknown })
      }
    })
    const receipt = events.find(e => e.type === "receipt") as { receipt: { runId: string; agentId?: string } } | undefined
    expect(receipt).toBeDefined()
    expect(receipt!.receipt.runId).toBe("ctx-run-1")
    expect(receipt!.receipt.agentId).toBe("ctx-agent")
  })

  linuxOnly("broker runtimeContext shares a single ledger across consumers", async () => {
    const { createLinuxBroker } = await import("../../../src/runtime/linux/broker")
    const broker = createLinuxBroker({ mode: "enabled" })
    const ctx = broker.runtimeContext()
    expect(ctx.ledger).toBe(broker.ledger())
    expect(ctx.locks).toBeDefined()
    expect(ctx.domainManager).toBeDefined()
    expect(ctx.cacheManager).toBeDefined()
    expect(ctx.stateStore).toBeDefined()
  })
})
