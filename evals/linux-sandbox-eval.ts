/** LNXF LF-8: Linux sandbox production evaluation — 37 scenarios (LX-001..037).
 *
 *  Each scenario runs against the real runtime; environment-dependent
 *  scenarios (no bwrap/podman on this machine) report SKIP with a reason.
 *  A scenario fails only when the runtime misbehaves.
 *
 *  Run: `bun run evals/linux-sandbox-eval.ts` (package script `eval:linux`).
 */

import { platform } from "node:os"
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { probeLinuxCapabilities, capabilitiesDigest } from "../src/runtime/linux/capability-probe"
import { buildExplicitEnvironment, hostKeyDenied } from "../src/runtime/linux/environment"
import { runSupervised } from "../src/runtime/linux/process/supervisor"
import { terminateTree, countProcessGroup } from "../src/runtime/linux/process/termination"
import { validateMountSet, validateMountRule } from "../src/runtime/linux/policy-compiler"
import { buildReceipt, receiptComplete } from "../src/runtime/linux/receipt"
import { selectBackend } from "../src/runtime/linux/backend-router"
import { createLinuxBroker } from "../src/runtime/linux/broker"
import { createBubblewrapBackend } from "../src/runtime/linux/backends/bubblewrap"
import { createPodmanBackend, validateImageRef } from "../src/runtime/linux/backends/podman"
import { ResourceLedger } from "../src/runtime/linux/scheduler/resource-ledger"
import { IsolationDomainLock } from "../src/runtime/linux/workspace/isolation-lock"
import { PortLeaseManager, validateBindAddress } from "../src/runtime/linux/workspace/cache-port"
import { AgentDomainManager } from "../src/runtime/linux/workspace/agent-domain"
import { CgroupManager, hierarchyPaths, type CgroupFs } from "../src/runtime/linux/cgroup/manager"
import { detectDelegatedRoot } from "../src/runtime/linux/cgroup/delegation"
import { readCgroupMetrics } from "../src/runtime/linux/cgroup/metrics"
import { buildEgressPolicy, checkEgressHop, checkEgressRedirect, dnsRebindingGuard } from "../src/runtime/linux/network-policy"
import { compileLandlockRuleset, compileSeccompProfile, seccompBackwardCompatible, landlockUsable } from "../src/runtime/linux/landlock-seccomp"
import { RuntimeStateStore, BootIdentityStore, startupJanitor, procStartTicksOf } from "../src/runtime/linux/recovery/state-store"
import { createRuntimeExecutionContext, runWithRuntimeExecutionContext, setExecutionAuthority } from "../src/runtime/execution-context"
import type { ExecutionCellSpec, LinuxCapabilities, ResourceRequest, TrustedExecutionAuthority } from "../src/runtime/linux/contracts"

export interface ScenarioResult {
  id: string
  name: string
  status: "PASS" | "FAIL" | "SKIP"
  detail?: string
}

export interface EvalReport {
  version: string
  ranAt: number
  platform: string
  capabilitiesDigest: string
  results: ScenarioResult[]
  pass: number
  fail: number
  skip: number
  total: number
  requiredCapabilities: RequiredLinuxCapability[]
  requiredFailures: string[]
}

type ScenarioOutcome = { pass?: boolean; skip?: boolean; reason?: string }

export type RequiredLinuxCapability = "bubblewrap" | "podman" | "cgroup"

export interface LinuxSandboxEvalOptions {
  requiredCapabilities?: readonly RequiredLinuxCapability[]
}

function scenarioPassed(results: readonly ScenarioResult[], id: string): boolean {
  return results.some(result => result.id === id && result.status === "PASS")
}

/** Capability-specific CI lanes fail closed without making unrelated optional
 * backends mandatory. A lane must both detect its real backend and pass the
 * scenarios that exercise that backend; a SKIP never satisfies the lane. */
export function requiredCapabilityFailures(
  capabilities: LinuxCapabilities,
  results: readonly ScenarioResult[],
  required: readonly RequiredLinuxCapability[],
): string[] {
  const failures: string[] = []
  for (const capability of new Set(required)) {
    if (capability === "bubblewrap") {
      if (!capabilities.bubblewrap.available || !capabilities.bubblewrap.unprivilegedUsable) {
        failures.push("bubblewrap: backend unavailable or user namespaces unusable")
      } else if (!scenarioPassed(results, "LX-012")) {
        failures.push("bubblewrap: LX-012 real network namespace scenario did not PASS")
      }
    } else if (capability === "podman") {
      if (!capabilities.podman.available || !capabilities.podman.rootlessReady) {
        failures.push("podman: rootless backend unavailable")
      } else if (!scenarioPassed(results, "LX-030")) {
        failures.push("podman: LX-030 real container scenario did not PASS")
      }
    } else if (capability === "cgroup") {
      if (!capabilities.cgroup.delegated) {
        failures.push("cgroup: writable delegated cgroup unavailable")
      }
      for (const id of ["LX-016", "LX-017", "LX-018", "LX-019"]) {
        if (!scenarioPassed(results, id)) failures.push(`cgroup: ${id} did not PASS`)
      }
    }
  }
  return failures
}

function spec(overrides: Partial<ExecutionCellSpec> = {}): ExecutionCellSpec {
  return {
    schemaVersion: "1.0",
    identity: { cellId: "lx", runId: "lx-eval", nodeRunId: "lx:n", attempt: 1 },
    command: { executable: "/bin/true", args: [], cwd: "/tmp", stdin: "closed" },
    profile: "inspect",
    isolation: { minimum: "audit", preferredBackend: "host-audit", allowDegradation: true },
    filesystem: { readonlyMounts: [], writableMounts: [], tmpfsMounts: [], hiddenPaths: [], emptyHome: true, worktreeRoot: "/tmp" },
    network: { mode: "none" },
    environment: { variables: {}, inheritHost: false, locale: "C.UTF-8", pathEntries: [] },
    secrets: [],
    resources: { memoryMaxBytes: 1024, pidsMax: 32, wallTimeMs: 10_000, stdoutMaxBytes: 1024, stderrMaxBytes: 1024, tmpfsMaxBytes: 1024 },
    cache: [],
    lifecycle: { killOnParentExit: true, cleanupOnExit: true, retainOnFailure: false, serviceMode: false },
    policyDigest: "",
    ...overrides,
  }
}

/** 简单 mock cgroupfs（无委托环境的资源场景验证）。 */
function mockCgroupFs(): CgroupFs {
  const state = new Map<string, string>()
  const dirs = new Set<string>(["/sys/fs/cgroup"])
  return {
    exists: p => dirs.has(p) || state.has(p) || p.endsWith("cgroup.subtree_control"),
    read(p) {
      const v = state.get(p)
      if (v !== undefined) return v
      if (p.endsWith("cgroup.controllers")) return "cpuset cpu io memory hugetlb pids"
      if (p.endsWith("cgroup.subtree_control")) return "cpu memory pids"
      throw new Error(`missing ${p}`)
    },
    write(p, c) {
      if (p.endsWith("cgroup.subtree_control")) {
        state.set(p, `${state.get(p) ?? "cpu memory pids"} ${c}`.trim())
        return
      }
      state.set(p, c)
    },
    mkdir(p) {
      dirs.add(p)
      for (const a of ["cgroup.procs", "cgroup.kill", "pids.max", "memory.max", "memory.events", "memory.current", "memory.oom.group", "cpu.max"]) {
        state.set(`${p}/${a}`, a === "pids.max" ? "max" : a === "memory.events" ? "oom 0\noom_kill 0" : "0")
      }
    },
    rm(p) {
      for (const k of [...state.keys()]) if (k.startsWith(p)) state.delete(k)
      for (const d of [...dirs]) if (d.startsWith(p)) dirs.delete(d)
    },
    readdir(p) {
      return [...dirs].filter(d => d.startsWith(p + "/")).map(d => d.slice(p.length + 1).split("/")[0] ?? "")
    },
  }
}

function resourceRequest(overrides: Partial<ResourceRequest> = {}): ResourceRequest {
  return { cpuQuota: 100, memoryBytes: 100, pids: 5, ioWeight: 0, networkSlots: 0, tempBytes: 100, ...overrides }
}

/** 炸弹进程树清理：直接 SIGKILL + 进程组树杀（依赖 detached 组）+ 归零验证。
 *
 *  WSL2 下进程迁移 EACCES（源 /init.scope root 属主不可写）时若只杀直接
 *  进程（proc.kill），炸弹子进程（`while true; do :; done` 子 shell、
 *  `head|tr` 管道）会逃逸成孤儿持续烧 CPU —— eval 连跑会累积成进程爆炸
 *  （曾致 WSL 过载崩溃）。detached spawn 使炸弹成为独立进程组领导，
 *  terminateTree 的 -pid 组杀才能命中整树并归零验证。 */
function killBombTree(pid: number | undefined): void {
  if (!pid || pid <= 0) return
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    /* already gone */
  }
  terminateTree(pid, { graceMs: 150, attempts: 3 })
}

/** Let the runtime reap killed children while waiting for a real cgroup to drain. */
async function waitCgroupEmptyAsync(manager: CgroupManager, path: string, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (manager.pidsCurrent(path) === 0) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return manager.pidsCurrent(path) === 0
}

function removeEvalCgroupRun(manager: CgroupManager, runId: string): void {
  const runPath = hierarchyPaths(manager.base, runId, undefined, "cleanup").run
  if (!manager.removeRun(runPath)) {
    throw new Error(`CGROUP_LEAK: failed to remove eval run ${runPath}`)
  }
}

export async function runLinuxSandboxEval(options: LinuxSandboxEvalOptions = {}): Promise<EvalReport> {
  const caps = probeLinuxCapabilities()
  const isLinux = platform() === "linux"
  const results: ScenarioResult[] = []
  const requiredCapabilities = [...new Set(options.requiredCapabilities ?? [])]

  const add = async (id: string, name: string, run: () => Promise<ScenarioOutcome>) => {
    let outcome: ScenarioOutcome
    try {
      outcome = await run()
    } catch (error) {
      outcome = { pass: false, reason: error instanceof Error ? error.message : String(error) }
    }
    const status: ScenarioResult["status"] = outcome.pass === true ? "PASS" : outcome.skip === true ? "SKIP" : "FAIL"
    results.push({ id, name, status, detail: outcome.reason })
  }

  const P = async (fn: () => Promise<boolean>, failReason: string): Promise<ScenarioOutcome> => {
    try {
      return (await fn()) ? { pass: true } : { pass: false, reason: failReason }
    } catch (error) {
      return { pass: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  // ── LX-001..005 能力探测 ──
  await add("LX-001", "能力探测（cgroup v2/namespaces/后端）", async () => {
    if (!isLinux) return { skip: true, reason: "非 Linux" }
    const ok = caps.cgroup.version === 2 && caps.namespaces.user && caps.namespaces.mount && caps.namespaces.pid
    return ok ? { pass: true } : { pass: false, reason: `cgroup=${caps.cgroup.version} user-ns=${caps.namespaces.user}` }
  })
  await add("LX-002", "无 cgroup 委托 → 严格任务 fail-closed", async () => {
    if (!isLinux) return { skip: true, reason: "非 Linux" }
    const delegated = detectDelegatedRoot()
    if (delegated.writable) return { pass: true, reason: `委托可用（${delegated.source}）` }
    const strict = spec({
      profile: "evolution",
      isolation: { minimum: "container", preferredBackend: "podman", allowDegradation: false },
    })
    try {
      const selection = selectBackend(strict, caps)
      return selection.backend === "rootless-podman"
        ? { pass: true, reason: "无委托但 podman 严格后端可用" }
        : { pass: false, reason: `无委托时严格任务被接受: ${selection.backend}` }
    } catch (error) {
      return { pass: true, reason: `无委托，严格任务已拒绝: ${(error as Error).message.slice(0, 70)}` }
    }
  })
  await add("LX-003", "user namespace 探测", async () => {
    if (!isLinux) return { skip: true, reason: "非 Linux" }
    return caps.namespaces.user ? { pass: true } : { pass: false, reason: "user ns 不可用" }
  })
  await add("LX-004", "无 Bubblewrap → 明确降级原因", async () => {
    if (!isLinux) return { skip: true, reason: "非 Linux" }
    return caps.bubblewrap.available || caps.degradationReasons.some(r => r.includes("bubblewrap"))
      ? { pass: true }
      : { pass: false, reason: "bubblewrap 缺失且无原因" }
  })
  await add("LX-005", "无 Podman → 明确降级原因", async () => {
    if (!isLinux) return { skip: true, reason: "非 Linux" }
    return caps.podman.available || caps.degradationReasons.some(r => r.includes("podman"))
      ? { pass: true }
      : { pass: false, reason: "podman 缺失且无原因" }
  })

  // ── LX-006..011 环境与可见性（HOST_ENV_SECRET_LEAK: 0 等） ──
  await add("LX-006", "环境变量泄漏（HOST_ENV_SECRET_LEAK: 0）", async () => {
    const built = buildExplicitEnvironment({
      policy: { baseProfile: "minimal", allowedHostKeys: [], fixedValues: {}, requestedValues: {}, deniedKeys: [] },
      runId: "r", nodeRunId: "r:n",
    })
    const leaked = Object.keys(built.env).filter(k => hostKeyDenied(k))
    return leaked.length === 0 ? { pass: true } : { pass: false, reason: `leaked: ${leaked.join(",")}` }
  })
  await add("LX-007", "真实 Home 读取防护（HOME_VISIBILITY: 0）", async () => {
    if (!isLinux) return { skip: true, reason: "非 Linux" }
    const backend = createBubblewrapBackend()
    const errors = backend.validateSpec(spec({
      filesystem: { ...spec().filesystem, readonlyMounts: [{ source: "/home/u", target: "/h", mode: "ro", required: true, recursive: true }] },
    }))
    return errors.length > 0 ? { pass: true } : { pass: false, reason: "home mount not rejected" }
  })
  await add("LX-008", "SSH/云凭证不可见（CREDENTIAL_VISIBILITY: 0）", async () => {
    if (!isLinux) return { skip: true, reason: "非 Linux" }
    const backend = createBubblewrapBackend()
    const errors = backend.validateSpec(spec({
      filesystem: { ...spec().filesystem, readonlyMounts: [{ source: "/home/u/.ssh", target: "/ssh", mode: "ro", required: true, recursive: true }] },
    }))
    return errors.length > 0 ? { pass: true } : { pass: false, reason: "ssh mount not rejected" }
  })
  await add("LX-009", "容器 Socket 不可见（CONTAINER_SOCKET_VISIBLE: 0）", async () => {
    if (!isLinux) return { skip: true, reason: "非 Linux" }
    const backend = createBubblewrapBackend()
    const errors = backend.validateSpec(spec({
      filesystem: { ...spec().filesystem, readonlyMounts: [{ source: "/run/docker.sock", target: "/run/docker.sock", mode: "ro", required: true, recursive: false }] },
    }))
    return errors.length > 0 ? { pass: true } : { pass: false, reason: "docker.sock not rejected" }
  })
  await add("LX-010", "项目外写入（PROJECT_ESCAPE: 0）", async () => {
    if (!isLinux) return { skip: true, reason: "非 Linux" }
    const root = mkdtempSync(join(tmpdir(), "lx010-root-"))
    const other = mkdtempSync(join(tmpdir(), "lx010-other-"))
    try {
      const escape = validateMountSet([{ source: other, target: "/workspace", mode: "rw", required: true, recursive: true }], root)
      return !escape.ok ? { pass: true } : { pass: false, reason: "project escape not blocked" }
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(other, { recursive: true, force: true })
    }
  })
  await add("LX-011", "符号链接逃逸（realpath 校验）", async () => {
    if (!isLinux) return { skip: true, reason: "非 Linux" }
    const root = mkdtempSync(join(tmpdir(), "lx011-root-"))
    const outside = mkdtempSync(join(tmpdir(), "lx011-out-"))
    try {
      const link = join(root, "link")
      symlinkSync(outside, link)
      const checked = validateMountRule({ source: link, target: "/workspace", mode: "rw", required: true, recursive: true }, root)
      return checked.ok ? { pass: false, reason: "symlink escape accepted" } : { pass: true }
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  // ── LX-012..014 网络 ──
  await add("LX-012", "none 模式无外连（NETWORK_EGRESS_NONE: 0）", async () => {
    if (!isLinux) return { skip: true, reason: "非 Linux" }
    // PR-8：bwrap 可用 → 真实外网连接尝试必须失败（不再只查策略拒绝）。
    if (caps.bubblewrap.available) {
      const backend = createBubblewrapBackend()
      const errors = backend.validateSpec(spec({ network: { mode: "none" } }))
      if (errors.length > 0) return { pass: false, reason: `none 被拒: ${errors.join(";")}` }
      const wt = mkdtempSync(join(tmpdir(), "lx012-"))
      try {
        const events: string[] = []
        for await (const event of backend.run(spec({
          command: { executable: "/bin/sh", args: ["-c", "(exec 3<>/dev/tcp/1.1.1.1/80) 2>/dev/null && echo CONNECTED || echo NO_NET"], cwd: wt, stdin: "closed" },
          filesystem: { ...spec().filesystem, worktreeRoot: wt },
        }), { capabilities: caps })) {
          if (event.type === "cell.stdout") events.push(event.data)
        }
        return events.join("").includes("NO_NET")
          ? { pass: true }
          : { pass: false, reason: `真实外连成功: ${events.join("")}` }
      } finally {
        rmSync(wt, { recursive: true, force: true })
      }
    }
    // 无 bwrap：策略层拒绝非 none/loopback 网络（真实策略验证）。
    const backend = createBubblewrapBackend()
    const errors = backend.validateSpec(spec({ network: { mode: "full-approved" } }))
    return errors.length > 0 ? { pass: true } : { pass: false, reason: "full-approved accepted without approval" }
  })
  await add("LX-013", "Loopback（隔离 netns 内）", async () => {
    if (!isLinux) return { skip: true, reason: "非 Linux" }
    // service profile 允许 loopback（PR-1：network 只能比 Profile 默认更严格）。
    const backend = createBubblewrapBackend()
    const errors = backend.validateSpec(spec({
      profile: "service",
      isolation: { minimum: "namespace", preferredBackend: "bubblewrap", allowDegradation: false },
      network: { mode: "loopback" },
    }))
    return errors.length === 0 ? { pass: true } : { pass: false, reason: `loopback rejected: ${errors.join(";")}` }
  })
  await add("LX-014", "DNS Rebinding + 重定向复查（REDIRECT_POLICY_BYPASS: 0）", async () => {
    const policy = buildEgressPolicy(["trusted.dev"], [443])
    const guard = dnsRebindingGuard(policy, "trusted.dev", "127.0.0.1")
    const hop = checkEgressHop(policy, { host: "trusted.dev", port: 443 })
    const hopBad = checkEgressHop(policy, { host: "trusted.dev", port: 22 })
    const redirect = checkEgressRedirect(policy, { host: "trusted.dev", port: 443 }, { host: "evil.dev", port: 443 })
    return !guard.allowed && hop.allowed && !hopBad.allowed && !redirect.allowed
      ? { pass: true }
      : { pass: false, reason: "network policy checks broken" }
  })

  // ── LX-015..020 资源与执行 ──
  await add("LX-015", "输出炸弹（OUTPUT_LIMIT_BYPASS: 0，超限即杀）", async () => {
    if (!isLinux) return { skip: true, reason: "非 Linux" }
    // PR-8：真实无限输出（无 head 截断）—— 进程必须被终止而非跑满墙钟。
    const startedAt = Date.now()
    const result = await runSupervised({
      executable: "/bin/sh", args: ["-c", "yes x"], cwd: "/tmp",
      env: { PATH: "/usr/bin:/bin", HOME: "/home/orcana" },
      limits: { stdoutMaxBytes: 1024, stderrMaxBytes: 1024 }, wallTimeMs: 60_000,
    })
    const elapsed = Date.now() - startedAt
    return result.outputLimitHit && elapsed < 10_000
      ? { pass: true }
      : { pass: false, reason: `output limit bypass (hit=${result.outputLimitHit}, elapsed=${elapsed}ms)` }
  })
  await add("LX-016", "内存炸弹（MEMORY_LIMIT_ENFORCED，真实分配）", async () => {
    if (!isLinux) return { skip: true, reason: "非 Linux" }
    const delegated = detectDelegatedRoot()
    if (!delegated.writable) {
      // PR-8：无委托 = 无法真实验证 —— FAIL（不再 mock auto-pass，不允许静默假绿）。
      return { pass: false, reason: "CGROUP_DELEGATION_REQUIRED: 无委托 cgroup，真实内存炸弹无法执行" }
    }
    const manager = new CgroupManager({ base: delegated.base })
    manager.createRun("lx") // LNXF-R2 10.4：完整授权链（run→agent→cell），
    manager.createAgent("lx", "a") // 独立 createCell 会因父层未授权 fail-loud
    const cell = manager.createCell("lx", "a", "mem", { memoryMaxBytes: 64 * 1024 * 1024, pidsMax: 8, oomGroup: true })
    try {
      const { spawn, spawnSync } = await import("node:child_process")
      // READY + SIGUSR2 是两阶段启动闸门：必须先确认 handler 已安装，再
      // attach，最后发信号开始分配，避免短暂在宿主 cgroup 中烧内存。
      // 持续保留内存块才是真实堆增长；流式 head|tr 不会积累工作集，
      // 不能作为 memory.max 的证据。
      const allocator = [
        "import signal, time",
        "chunks = []",
        "def allocate(_signum, _frame):",
        "    while True:",
        "        block = bytearray(8 * 1024 * 1024)",
        "        for offset in range(0, len(block), 4096):",
        "            block[offset] = 1",
        "        chunks.append(block)",
        "signal.signal(signal.SIGUSR2, allocate)",
        "print('READY', flush=True)",
        "while True:",
        "    time.sleep(1)",
      ].join("\n")
      // Python bytearray 是单调持有的匿名内存，不受 V8 外部内存 GC 策略
      // 影响；GitHub Ubuntu 与当前 WSL 都提供 python3。
      const proc = spawn("python3", ["-c", allocator], { detached: true, stdio: ["ignore", "pipe", "ignore"] })
      const ready = await new Promise<boolean>(resolve => {
        let settled = false
        let timeout: ReturnType<typeof setTimeout> | undefined
        const finish = (value: boolean) => {
          if (settled) return
          settled = true
          if (timeout) clearTimeout(timeout)
          resolve(value)
        }
        proc.stdout?.once("data", chunk => finish(String(chunk).includes("READY")))
        proc.once("exit", () => finish(false))
        timeout = setTimeout(() => finish(false), 2_000)
      })
      if (!ready) {
        killBombTree(proc.pid)
        return { pass: false, reason: "内存分配器 READY 握手失败" }
      }
      try {
        manager.attach(proc.pid ?? 0, cell)
      } catch {
        // 只杀直接进程会让炸弹子进程逃逸成孤儿持续烧 CPU —— 树杀归零。
        killBombTree(proc.pid)
        return { skip: true, reason: "进程迁移 EACCES（源 cgroup /init.scope root 属主不可写）—— 真机 lane 验收" }
      }
      const before = manager.memoryEvents(cell)
      const exitedPromise = new Promise<boolean>(resolve => {
        let settled = false
        let timeout: ReturnType<typeof setTimeout> | undefined
        const finish = (value: boolean) => {
          if (settled) return
          settled = true
          if (timeout) clearTimeout(timeout)
          resolve(value)
        }
        proc.once("exit", () => finish(true))
        timeout = setTimeout(() => {
          killBombTree(proc.pid)
          finish(false)
        }, 8000)
      })
      const signal = spawnSync("/bin/kill", ["-USR2", String(proc.pid)], { encoding: "utf8", timeout: 2_000 })
      if (signal.status !== 0) {
        killBombTree(proc.pid)
        await exitedPromise
        return { pass: false, reason: `内存分配器启动信号失败: ${signal.stderr.trim()}` }
      }
      let after = before
      const evidenceDeadline = Date.now() + 5_000
      while (Date.now() < evidenceDeadline) {
        after = manager.memoryEvents(cell)
        const maxDelta = (after.max ?? 0) - (before.max ?? 0)
        const oomDelta = (after.oom ?? 0) - (before.oom ?? 0)
        const oomKillDelta = (after.oom_kill ?? 0) - (before.oom_kill ?? 0)
        if (maxDelta > 0 || oomDelta > 0 || oomKillDelta > 0) break
        if (proc.exitCode !== null) break
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      // memory.max 命中已经证明内核执行限额；立即停止压力源，不继续用
      // CPU 反复触发 direct reclaim 等待可选的 OOM-kill 策略。
      killBombTree(proc.pid)
      const exited = await exitedPromise
      after = manager.memoryEvents(cell)
      const maxDelta = (after.max ?? 0) - (before.max ?? 0)
      const oomDelta = (after.oom ?? 0) - (before.oom ?? 0)
      const oomKillDelta = (after.oom_kill ?? 0) - (before.oom_kill ?? 0)
      return (maxDelta > 0 || oomKillDelta > 0 || oomDelta > 0)
        ? { pass: true, reason: `max_delta=${maxDelta} oom_kill_delta=${oomKillDelta} oom_delta=${oomDelta} reaped=${exited}` }
        : { pass: false, reason: `内存限制无命中证据 max_delta=${maxDelta} oom_kill_delta=${oomKillDelta} oom_delta=${oomDelta} reaped=${exited}` }
    } finally {
      // OOM exit 事件可能早于 cgroup 的 populated 状态完成回收。无论场景
      // 判定如何，先树杀兜底并异步等待归零，再删除完整 run。
      manager.kill(cell)
      await waitCgroupEmptyAsync(manager, cell, 5_000)
      removeEvalCgroupRun(manager, "lx")
    }
  })
  await add("LX-017", "Fork Bomb（PIDS_LIMIT_ENFORCED，真实 fork）", async () => {
    if (!isLinux) return { skip: true, reason: "非 Linux" }
    const delegated = detectDelegatedRoot()
    if (!delegated.writable) {
      return { pass: false, reason: "CGROUP_DELEGATION_REQUIRED: 无委托 cgroup，真实 fork bomb 无法执行" }
    }
    const manager = new CgroupManager({ base: delegated.base })
    manager.createRun("lx")
    manager.createAgent("lx", "a")
    const cell = manager.createCell("lx", "a", "fork", { memoryMaxBytes: 64 * 1024 * 1024, pidsMax: 16 })
    try {
      const { spawn } = await import("node:child_process")
      // LNXF-R2 10.1：WSL2 控制台进程挂 root 属主 /init.scope —— 迁移
      // EACCES（源 cgroup 不可写，45eba78 已知场景）；真机 lane 验收。
      // detached：炸弹须为独立进程组领导，EACCES fallback 的组杀才能命中整树。
      const proc = spawn("/bin/sh", ["-c", "while true; do ( while true; do :; done & ); done"], { detached: true, stdio: "ignore" })
      try {
        manager.attach(proc.pid ?? 0, cell)
      } catch {
        // 只杀直接进程会让 fork 炸弹子 shell 逃逸成孤儿持续烧 CPU —— 树杀归零。
        killBombTree(proc.pid)
        return { skip: true, reason: "进程迁移 EACCES（源 cgroup /init.scope root 属主不可写）—— 真机 lane 验收" }
      }
      const start = Date.now()
      await new Promise(r => setTimeout(r, 1500))
      const current = manager.pidsCurrent(cell)
      // pids.max=16 → 进程必须被限制住（current ≤ max + 少量）
      const killed = manager.kill(cell).killed
      const stopped = killed && await waitCgroupEmptyAsync(manager, cell)
      const elapsed = Date.now() - start
      return (current <= 32 && killed && stopped)
        ? { pass: true, reason: `pids.current=${current} 受限且归零(${elapsed}ms)` }
        : { pass: false, reason: `fork bomb 未受限 current=${current} killed=${killed} stopped=${stopped}` }
    } finally {
      removeEvalCgroupRun(manager, "lx")
    }
  })
  await add("LX-018", "CPU Hog（cpu.max 节流，真实负载）", async () => {
    if (!isLinux) return { skip: true, reason: "非 Linux" }
    const delegated = detectDelegatedRoot()
    if (!delegated.writable) {
      return { pass: false, reason: "CGROUP_DELEGATION_REQUIRED: 无委托 cgroup，真实 CPU hog 无法执行" }
    }
    const manager = new CgroupManager({ base: delegated.base })
    manager.createRun("lx")
    manager.createAgent("lx", "a")
    const cell = manager.createCell("lx", "a", "cpu", { memoryMaxBytes: 64 * 1024 * 1024, pidsMax: 8, cpuQuotaMicros: 50_000, cpuPeriodMicros: 100_000 })
    try {
      const { spawn } = await import("node:child_process")
      // LNXF-R2 10.1：WSL2 控制台进程挂 root 属主 /init.scope —— 迁移
      // EACCES（源 cgroup 不可写，45eba78 已知场景）；真机 lane 验收。
      // detached：炸弹须为独立进程组领导，EACCES fallback 的组杀才能命中整树。
      const proc = spawn("/bin/sh", ["-c", "while true; do :; done"], { detached: true, stdio: "ignore" })
      try {
        manager.attach(proc.pid ?? 0, cell)
      } catch {
        // 只杀直接进程会让 CPU hog 子 shell 逃逸成孤儿持续烧 CPU —— 树杀归零。
        killBombTree(proc.pid)
        return { skip: true, reason: "进程迁移 EACCES（源 cgroup /init.scope root 属主不可写）—— 真机 lane 验收" }
      }
      await new Promise(r => setTimeout(r, 2500))
      const metrics = readCgroupMetrics(cell, manager.fs)
      const killed = manager.kill(cell).killed
      const stopped = killed && await waitCgroupEmptyAsync(manager, cell)
      // cpu.max=50% → 2.5s 内节流时间应显著（≥ 200ms）
      return (metrics.cpuThrottledUsec ?? 0) >= 200_000 && killed && stopped
        ? { pass: true, reason: `throttled=${metrics.cpuThrottledUsec}us` }
        : { pass: false, reason: `cpu.max 未生效 throttled=${metrics.cpuThrottledUsec}us killed=${killed} stopped=${stopped}` }
    } finally {
      removeEvalCgroupRun(manager, "lx")
    }
  })
  await add("LX-019", "OOM 事件指标（真实内核事件读取）", async () => {
    if (!isLinux) return { skip: true, reason: "非 Linux" }
    const delegated = detectDelegatedRoot()
    if (!delegated.writable) {
      return { pass: false, reason: "CGROUP_DELEGATION_REQUIRED: 无委托 cgroup，真实 metrics 无法读取" }
    }
    const manager = new CgroupManager({ base: delegated.base })
    manager.createRun("lx")
    manager.createAgent("lx", "a")
    const cell = manager.createCell("lx", "a", "tmp", { memoryMaxBytes: 16 * 1024 * 1024, pidsMax: 8 })
    try {
      const metrics = readCgroupMetrics(cell, manager.fs)
      return (typeof metrics.cpuUsageUsec === "number" && typeof metrics.oomKills === "number")
        ? { pass: true, reason: `cpu=${metrics.cpuUsageUsec}us oom_kill=${metrics.oomKills}` }
        : { pass: false, reason: "metrics 读取失败" }
    } finally {
      removeEvalCgroupRun(manager, "lx")
    }
  })
  await add("LX-020", "超时（PROCESS_TIMEOUT）", async () => {
    if (!isLinux) return { skip: true, reason: "非 Linux" }
    const result = await runSupervised({
      executable: "/bin/sh", args: ["-c", "sleep 30"], cwd: "/tmp",
      env: { PATH: "/usr/bin:/bin", HOME: "/home/orcana" },
      limits: { stdoutMaxBytes: 1024, stderrMaxBytes: 1024 }, wallTimeMs: 400,
    })
    return result.timedOut ? { pass: true } : { pass: false, reason: "no timeout" }
  })

  // ── LX-021..025 取消与后台 ──
  await add("LX-021", "Cell 取消（CGROUP_TREE_KILL 进程组归零）", async () => {
    if (!isLinux) return { skip: true, reason: "非 Linux" }
    const controller = new AbortController()
    const promise = runSupervised({
      executable: "/bin/sh", args: ["-c", "sleep 30"], cwd: "/tmp",
      env: { PATH: "/usr/bin:/bin", HOME: "/home/orcana" },
      limits: { stdoutMaxBytes: 1024, stderrMaxBytes: 1024 }, wallTimeMs: 30_000, abortSignal: controller.signal,
    })
    setTimeout(() => controller.abort(), 200)
    const result = await promise
    return result.cancelled ? { pass: true } : { pass: false, reason: "cancel not observed" }
  })
  await add("LX-022", "Agent 取消（AGENT_CANCEL_ISOLATION）", async () => {
    const manager = new AgentDomainManager()
    manager.createDomain({
      runId: "r", agentId: "a1", worktreeRoot: "/wt", ownerFiles: [],
      resourceBudget: { maxConcurrentCells: 1, cpuQuotaTotal: 100, memoryMaxBytes: 100, pidsMax: 10, maxWallTimeMs: 100, maxOutputBytes: 100, maxTempBytes: 100 },
    })
    const cancelled = manager.cancelAgent("a1")
    const domain = manager.byAgent("a1")
    return cancelled && domain?.status === "cancelling" ? { pass: true } : { pass: false, reason: "agent cancel failed" }
  })
  await add("LX-023", "Run 取消资源释放 + RESOURCE_OVERCOMMIT: 0", async () => {
    const ledger = new ResourceLedger({ maxConcurrentCells: 2, capacity: { cpuQuota: 1000, memoryBytes: 1024, pids: 10, networkSlots: 1, tempBytes: 1024, concurrentCells: 2 } })
    const r1 = ledger.reserve(resourceRequest(), "r1", "c1")
    const r2 = ledger.reserve(resourceRequest(), "r1", "c2")
    const over = ledger.reserve(resourceRequest(), "r2", "c3")
    if (!r1.ok || !r2.ok) return { pass: false, reason: "reserve failed under capacity" }
    const released = ledger.releaseRun("r1")
    return released === 2 && !over.ok && ledger.outstanding().length === 0
      ? { pass: true }
      : { pass: false, reason: `released=${released} over=${over.ok} outstanding=${ledger.outstanding().length}` }
  })
  await add("LX-024", "双 Fork（daemon 检测）", async () => {
    if (!isLinux) return { skip: true, reason: "非 Linux" }
    const result = await runSupervised({
      executable: "/bin/sh", args: ["-c", "setsid sh -c 'sleep 0.3' & sleep 0.15; exit 0"], cwd: "/tmp",
      env: { PATH: "/usr/bin:/bin", HOME: "/home/orcana" },
      limits: { stdoutMaxBytes: 1024, stderrMaxBytes: 1024 }, wallTimeMs: 10_000, detectDaemon: true,
    })
    return result.exitCode === 0 && result.orphanProcesses === 0
      ? { pass: true }
      : { pass: false, reason: `exit=${result.exitCode} orphans=${result.orphanProcesses}` }
  })
  await add("LX-025", "后台 Daemon 终止归零（ORPHAN_PROCESS_AFTER_CANCEL: 0）", async () => {
    if (!isLinux) return { skip: true, reason: "非 Linux" }
    const { spawn } = await import("node:child_process")
    const proc = spawn("/bin/sh", ["-c", "sleep 3 & sleep 3 & wait"], { detached: true, stdio: "ignore" })
    await new Promise(r => setTimeout(r, 300))
    const before = countProcessGroup(proc.pid ?? 0)
    const report = terminateTree(proc.pid ?? 0, { graceMs: 200, attempts: 2 })
    await new Promise(r => setTimeout(r, 300))
    const after = countProcessGroup(proc.pid ?? 0)
    return before >= 1 && after === 0 && report.processesRemaining === 0
      ? { pass: true }
      : { pass: false, reason: `before=${before} after=${after} remaining=${report.processesRemaining}` }
  })

  // ── LX-026..029 并发与锁 ──
  await add("LX-026", "Worktree 并发（CROSS_WORKTREE_SERIALIZATION: 0）", async () => {
    const lock = new IsolationDomainLock()
    const a = lock.acquire(IsolationDomainLock.worktreeKey("a"), "exclusive", "a")
    const b = lock.acquire(IsolationDomainLock.worktreeKey("b"), "exclusive", "b")
    const same = lock.acquire(IsolationDomainLock.worktreeKey("a"), "exclusive", "a2")
    return a && b && !same ? { pass: true } : { pass: false, reason: "worktree lock broken" }
  })
  await add("LX-027", "正式工作区单写者（MAIN_WORKSPACE_MULTI_WRITER: 0）", async () => {
    const lock = new IsolationDomainLock()
    const main = IsolationDomainLock.mainWorkspaceKey()
    lock.acquire(main, "exclusive", "a1")
    const second = lock.acquire(main, "exclusive", "a2")
    return second ? { pass: false, reason: "main workspace multi-writer" } : { pass: true }
  })
  await add("LX-028", "Cache 锁（rw-locked 排他，CACHE_CORRUPTION_CROSS_AGENT: 0）", async () => {
    const lock = new IsolationDomainLock()
    const key = IsolationDomainLock.cacheKey("npm", "v1")
    lock.acquire(key, "exclusive", "a1")
    const shared = lock.acquire(key, "shared", "a2")
    return shared ? { pass: false, reason: "cache lock broken" } : { pass: true }
  })
  await add("LX-029", "Port Lease（loopback only / 不重复 / 回收）", async () => {
    const manager = new PortLeaseManager({ hostPortRange: { start: 41_000, end: 41_002 } })
    const l1 = manager.lease({ runId: "r", cellId: "c1", internalPort: 8080, exposeToHost: true })
    const l2 = manager.lease({ runId: "r", cellId: "c2", internalPort: 8081, exposeToHost: true })
    const l3 = manager.lease({ runId: "r", cellId: "c3", internalPort: 8082, exposeToHost: true })
    const ok = l1?.hostPort === 41_000 && l2?.hostPort === 41_001 && l3?.hostPort === 41_002 &&
      l1?.bindAddress === "127.0.0.1" && validateBindAddress("0.0.0.0") === false
    manager.releaseRun("r")
    return ok && manager.activeLeases().length === 0 ? { pass: true } : { pass: false, reason: "port lease broken" }
  })

  // ── LX-030..032 严格后端与恢复 ──
  await add("LX-030", "Podman 真实容器执行 + 残留归零（FLOATING_IMAGE_ACCEPTED: 0）", async () => {
    if (!isLinux) return { skip: true, reason: "非 Linux" }
    if (!caps.podman.available || !caps.podman.rootlessReady) {
      // PR-8：podman 为可选依赖（CI podman lane 提供）；SKIP 必须显式 reason。
      return { skip: true, reason: "podman 未安装/未就绪（CI podman lane 负责真实验收）" }
    }
    const { spawnSync } = await import("node:child_process")
    const podmanPath = caps.podman.path ?? "podman"
    // 1. digest 锁定策略仍有效
    if (!validateImageRef("img@sha256:" + "b".repeat(64)).ok || validateImageRef("img:latest").ok) {
      return { pass: false, reason: "image policy broken" }
    }
    // 2. 真实容器执行（digest 镜像 + none 网络 + 只读）
    const inspect = spawnSync(podmanPath, ["image", "inspect", "--format", "{{.Digest}}", "docker.io/library/alpine:latest"], { encoding: "utf8", timeout: 30_000 })
    if (inspect.status !== 0) return { skip: true, reason: "alpine 镜像不可用（需 podman pull）" }
    const digest = inspect.stdout.trim()
    const image = `docker.io/library/alpine@${digest}`
    const run = spawnSync(podmanPath, [
      "run", "--rm", "--network=none", "--read-only", "--cap-drop=ALL",
      "--security-opt", "no-new-privileges", "--label", "io.orcana.run=lx030",
      "--label", "io.orcana.cell=lx030-cell", image, "echo", "real-podman-ok",
    ], { encoding: "utf8", timeout: 60_000 })
    if (run.status !== 0) return { pass: false, reason: `真实容器执行失败: ${run.stderr}` }
    if (!run.stdout.includes("real-podman-ok")) return { pass: false, reason: `容器输出异常: ${run.stdout}` }
    // 3. 残留归零：label 过滤确认无容器残留
    const leftover = spawnSync(podmanPath, ["ps", "-a", "-q", "--filter", "label=io.orcana.run=lx030"], { encoding: "utf8", timeout: 10_000 })
    return leftover.status === 0 && leftover.stdout.trim() === ""
      ? { pass: true, reason: `真实容器执行成功（${image.slice(0, 24)}…）且无残留` }
      : { pass: false, reason: `容器残留: ${leftover.stdout}` }
  })
  await add("LX-031", "严格任务不降级（STRICT_BACKEND_DEGRADED: 0）", async () => {
    if (!isLinux) return { skip: true, reason: "非 Linux" }
    const backend = createPodmanBackend()
    const strict = spec({
      profile: "untrusted",
      isolation: { minimum: "container", preferredBackend: "podman", allowDegradation: false },
      network: { mode: "none" },
    })
    if (caps.podman.available && caps.podman.rootlessReady) {
      const errors = backend.validateSpec(strict)
      return errors.length === 0 ? { pass: true } : { pass: false, reason: `strict spec rejected: ${errors.join(";")}` }
    }
    // 后端不可用 → 必须拒绝（fail-closed），不得静默降级到 host-audit。
    return P(async () => {
      try {
        const selection = selectBackend(strict, caps)
        return selection.backend === "rootless-podman"
      } catch {
        return true
      }
    }, "严格任务静默降级")
  })
  await add("LX-032", "崩溃恢复 Janitor（RECOVERY_WRONG_PROCESS_KILL: 0，同 boot owner 判定）", async () => {
    const root = mkdtempSync(join(tmpdir(), "lx032-"))
    try {
      const store = new RuntimeStateStore({ root })
      const boot = new BootIdentityStore(store)
      boot.recordBoot("old-boot")
      store.writeRun("crash-run", { status: "running" })
      const receipts = await startupJanitor({
        store, currentBootId: "new-boot",
        cleanupRun: async id => ({ cgroups: [`run-${id}`], worktrees: [], ports: 0, containers: [], services: 0, stateRemoved: true }),
      })
      // 同 boot 重启安全：janitor 之后写入、owner 存活的 run 不被清理（PR-7 owner token）。
      store.writeRun("live-run", {
        status: "running",
        ownerPid: process.pid,
        ownerProcStartTicks: procStartTicksOf(process.pid),
      })
      // 同 boot 崩溃：owner 已死的 run 必须被清理。
      store.writeRun("crashed-run", { status: "running", ownerPid: 999999, ownerProcStartTicks: 1 })
      const secondPass = await startupJanitor({
        store, currentBootId: "new-boot",
        cleanupRun: async id => ({ cgroups: [`run-${id}`], worktrees: [], ports: 0, containers: [], services: 0, stateRemoved: true }),
      })
      const cleaned = receipts.map(r => r.runId).sort().join(",")
      const secondCleaned = secondPass.map(r => r.runId).sort().join(",")
      const bootNow = new BootIdentityStore(store).lastBoot()
      // 幂等语义：无 owner token 的 crash-run 每次都会被保守清理；
      // owner 存活的 live-run 永不清理。
      return cleaned === "crash-run"
        && secondCleaned.includes("crashed-run")
        && !secondCleaned.includes("live-run")
        && bootNow === "new-boot"
        ? { pass: true, reason: `cleaned=${cleaned} sameBoot=${secondCleaned} live 保留` }
        : { pass: false, reason: `cleaned=${cleaned} sameBoot=${secondCleaned} boot=${bootNow}` }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // ── LX-033..035 安全回归 / Receipt / 兼容 ──
  await add("LX-033", "seccomp/Landlock 规则面 + 兼容门（Security Regression）", async () => {
    const oldProfile = compileSeccompProfile("inspect")
    const newProfile = compileSeccompProfile("untrusted")
    const compat = seccompBackwardCompatible(oldProfile, newProfile)
    const landlock = compileLandlockRuleset(caps, "inspect", "/workspace")
    const llGuard = landlockUsable(caps)
    return compat && landlock.abi === (caps.landlock.abi ?? 0) && (caps.landlock.available ? llGuard.ok : !llGuard.ok)
      ? { pass: true }
      : { pass: false, reason: `compat=${compat} landlockAbi=${landlock.abi}` }
  })
  await add("LX-034", "Receipt 完整性 + Evidence 绑定（SANDBOX_RECEIPT_INCOMPLETE: 0）", async () => {
    const receipt = buildReceipt({
      spec: spec(), capabilities: caps, backend: "bubblewrap",
      startedAt: 1, finishedAt: 2, exitCode: 0, signal: null,
      timedOut: false, cancelled: false, oomKilled: false, pidLimitHit: false, outputLimitHit: false, tempLimitHit: false,
      cleanup: { processesRemaining: 0, mountsReleased: true, cgroupRemoved: true, worktreeRetained: false },
    })
    const bound = {
      nodeRunId: receipt.nodeRunId, cellId: receipt.cellId, backend: receipt.backend,
      profile: receipt.profile, cellSpecDigest: receipt.cellSpecDigest,
      resourcePolicyDigest: receipt.resourcePolicyDigest, networkPolicyDigest: receipt.networkPolicyDigest,
      receiptDigest: receipt.receiptDigest,
    }
    return receiptComplete(receipt) && Object.values(bound).every(v => v !== undefined && v !== "")
      ? { pass: true }
      : { pass: false, reason: "receipt incomplete or binding missing" }
  })
  await add("LX-035", "单 Agent 兼容（shadow 编译零回归）", async () => {
    if (!isLinux) return { skip: true, reason: "非 Linux" }
    const broker = createLinuxBroker({ mode: "shadow" })
    const record = broker.shadow(spec())
    return record.compiled === true ? { pass: true } : { pass: false, reason: "shadow compile failed" }
  })

  // ── PR-8：真实端到端 ──
  await add("LX-036", "Receipt → Evidence → Completion Gate 端到端（真实执行链）", async () => {
    if (!isLinux) return { skip: true, reason: "非 Linux" }
    const { createEvidenceLedger, ingestSandboxReceipt, hasEvidence } = await import("../src/agent/evidence-ledger")
    const { cleanupProcessRun, collectProcessRun } = await import("../src/runtime/process-executor")
    const ledger = createEvidenceLedger()
    // 真实执行：collectProcessRun 携带真实 Receipt。PR-9 后 Linux enabled 执行
    // 必须处于可信执行权威下（AgentRunScope 注册工作区）——真实 mkdtemp
    // 工作区 + setExecutionAuthority 模拟生产信任链入口（agentLoop/AgentHarness
    // 同款，git_rt8/typescript_rc01 同模式）。
    const ws = mkdtempSync(join(tmpdir(), "lx036-"))
    let outcome: Awaited<ReturnType<typeof collectProcessRun>> | undefined
    try {
      const ctx = createRuntimeExecutionContext()
      outcome = await runWithRuntimeExecutionContext(ctx, async () => {
        const authority: TrustedExecutionAuthority = {
          identity: { runId: "lx036-run", nodeRunId: "lx036:n", attempt: 1 },
          workspace: {
            workspaceId: "lx036-ws",
            projectId: "lx036-proj",
            hostRoot: ws,
            kind: "main",
            access: "readwrite",
            physicalWorkspaceKey: `wp_${process.pid}_lx036`,
            ownerFiles: [],
          },
        }
        setExecutionAuthority(authority)
        return collectProcessRun({ command: "/bin/true", args: [], timeoutMs: 15_000 })
      })
    } finally {
      await cleanupProcessRun("lx036-run")
      rmSync(ws, { recursive: true, force: true })
    }
    if (!outcome?.receipt) return { pass: false, reason: "执行链未产出 Receipt" }
    // Receipt 自摘要与 Evidence 绑定
    if (outcome.receipt.runId !== "lx036-run") return { pass: false, reason: `身份未透传: ${outcome.receipt.runId}` }
    const entry = ingestSandboxReceipt(ledger, outcome.receipt)
    if (!entry) return { pass: false, reason: "Receipt 未入账 Evidence" }
    if (entry.receiptDigest !== outcome.receipt.receiptDigest) {
      return { pass: false, reason: "Evidence 未绑定 Receipt 自摘要" }
    }
    // Completion Gate：退出 0 + 非超时/取消 → passed
    const passed = entry.passed
    return passed && hasEvidence(ledger, "sandbox_execution")
      ? { pass: true, reason: `receiptDigest=${entry.receiptDigest} passed=${passed}` }
      : { pass: false, reason: `gate 判定失败 passed=${passed}` }
  })

  await add("LX-037", "跨 Agent 同路径竞争（Isolation Lock 真实拒绝）", async () => {
    if (!isLinux) return { skip: true, reason: "非 Linux" }
    const broker = createLinuxBroker({ mode: "enabled" })
    const wt = mkdtempSync(join(tmpdir(), "lx037-"))
    try {
      // 两个并发执行指向同一 worktree：第一个长跑占用，第二个必须被锁拒绝。
      const hold = spec({
        command: { executable: "/bin/sh", args: ["-c", "sleep 3"], cwd: wt, stdin: "closed" },
        filesystem: { ...spec().filesystem, worktreeRoot: wt },
        // The generic eval fixture uses a 1 KiB memory ceiling. With a real
        // cgroup that kills the holder before the competing writer arrives,
        // so the scenario never exercises lock contention.
        resources: { ...spec().resources, memoryMaxBytes: 64 * 1024 * 1024 },
        identity: { cellId: "lx037-1", runId: "lx037-run", nodeRunId: "lx037:n1", attempt: 1 },
      })
      const p1 = (async () => { for await (const _ of broker.execute(hold)) { /* drain */ } })()
      await new Promise(r => setTimeout(r, 150))
      let rejected = false
      try {
        const second = spec({
          command: { executable: "/bin/true", args: [], cwd: wt, stdin: "closed" },
          filesystem: { ...spec().filesystem, worktreeRoot: wt },
          identity: { cellId: "lx037-2", runId: "lx037-run", nodeRunId: "lx037:n2", attempt: 1 },
        })
        for await (const _ of broker.execute(second)) { /* drain */ }
      } catch (error) {
        rejected = String(error).includes("isolation lock held")
      }
      await p1
      return rejected ? { pass: true, reason: "同路径并发被锁拒绝（MAIN_WORKSPACE_MULTI_WRITER: 0）" } : { pass: false, reason: "同路径并发未被拒绝" }
    } finally {
      await broker.cleanupRun("lx037-run")
      rmSync(wt, { recursive: true, force: true })
    }
  })

  const pass = results.filter(r => r.status === "PASS").length
  const fail = results.filter(r => r.status === "FAIL").length
  const skip = results.filter(r => r.status === "SKIP").length
  const requiredFailures = requiredCapabilityFailures(caps, results, requiredCapabilities)
  return {
    version: "LNXF-1.0",
    ranAt: Date.now(),
    platform: platform(),
    capabilitiesDigest: capabilitiesDigest(caps),
    results,
    pass,
    fail,
    skip,
    total: results.length,
    requiredCapabilities,
    requiredFailures,
  }
}

/** CLI：bun run eval:linux [--strict] [--require=bubblewrap|podman|cgroup]
 *  --strict：关键场景不允许 SKIP —— 任何 SKIP 都视为失败（供具备
 *  全部 bwrap/podman/cgroup 能力的真机使用）。
 *  --require：能力专属 lane 只要求对应真实后端及其场景必须 PASS。 */
export async function linuxEvalCli(): Promise<number> {
  const strict = process.argv.includes("--strict")
  const requested = process.argv
    .filter(arg => arg.startsWith("--require="))
    .flatMap(arg => arg.slice("--require=".length).split(","))
    .filter(Boolean)
  const allowed = new Set<RequiredLinuxCapability>(["bubblewrap", "podman", "cgroup"])
  const invalid = requested.filter(value => !allowed.has(value as RequiredLinuxCapability))
  if (invalid.length > 0) {
    console.error(`Unknown required Linux capability: ${invalid.join(", ")}`)
    return 2
  }
  const requiredCapabilities = requested as RequiredLinuxCapability[]
  const report = await runLinuxSandboxEval({ requiredCapabilities })
  const requirementLabel = report.requiredCapabilities.length > 0
    ? ` [REQUIRE=${report.requiredCapabilities.join(",")}]`
    : ""
  console.log(`LNXF Linux Sandbox Eval — ${report.pass} pass, ${report.fail} fail, ${report.skip} skip (${report.total} scenarios)${strict ? " [STRICT]" : ""}${requirementLabel}`)
  for (const result of report.results) {
    const mark = result.status === "PASS" ? "ok" : result.status === "SKIP" ? "-" : "x"
    console.log(` [${mark}] ${result.id} ${result.name}${result.detail ? ` — ${result.detail}` : ""}`)
  }
  if (report.fail > 0) return 1
  if (report.requiredFailures.length > 0) {
    for (const failure of report.requiredFailures) console.log(`[required] ${failure}`)
    return 1
  }
  if (strict && report.skip > 0) {
    console.log(`[strict] ${report.skip} 个场景 SKIP —— 真机 lane 不允许跳过`)
    return 1
  }
  return 0
}

if (import.meta.main) {
  process.exit(await linuxEvalCli())
}
