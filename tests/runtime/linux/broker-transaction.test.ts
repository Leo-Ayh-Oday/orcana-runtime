/** LNXF R2: Broker 执行事务（资源预留/锁/cgroup attach/取消/清理/真实 Receipt）。 */

import { describe, expect, test } from "bun:test"
import { createLinuxBroker } from "../../../src/runtime/linux/broker"
import { testAuthorityFallback } from "../../../src/runtime/linux/broker"
import { ResourceLedger } from "../../../src/runtime/linux/scheduler/resource-ledger"
import { CgroupManager, type CgroupFs } from "../../../src/runtime/linux/cgroup/manager"
import { LinuxExecutionError } from "../../../src/runtime/linux/errors"
import type { ExecutionCellSpec } from "../../../src/runtime/linux/contracts"
import { join } from "node:path"

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
      for (const a of ["cgroup.procs", "cgroup.kill", "pids.max", "memory.max", "memory.events", "memory.current", "memory.oom.group", "cpu.max", "pids.current", "memory.peak", "pids.peak", "cpu.stat"]) {
        state.set(`${p}/${a}`, a === "pids.max" ? "max" : a === "pids.current" ? "0" : a === "memory.events" ? "oom 0\noom_kill 0" : a === "cpu.stat" ? "usage_usec 100\nt_hrottled_usec 0" : a === "memory.peak" ? "4096" : a === "pids.peak" ? "2" : "0")
      }
    },
    rm(p) {
      // PR-5 语义：非递归 rmdir（子目录由协议自底向上删除）。
      for (const k of [...state.keys()]) if (k.startsWith(p + "/")) state.delete(k)
      dirs.delete(p)
    },
    readdir(p) {
      return [...new Set([...dirs].filter(d => d.startsWith(p + "/")).map(d => d.slice(p.length + 1).split("/")[0] ?? ""))]
    },
  }
}

function cellSpec(overrides: Partial<ExecutionCellSpec> = {}): ExecutionCellSpec {
  return {
    schemaVersion: "1.0",
    identity: { cellId: `c-${Math.random().toString(36).slice(2, 8)}`, runId: "r1", nodeRunId: "r1:n", attempt: 1, agentId: "a1" },
    command: { executable: "/bin/true", args: [], cwd: "/tmp", stdin: "closed" },
    profile: "build",
    isolation: { minimum: "audit", preferredBackend: "host-audit", allowDegradation: true },
    filesystem: { readonlyMounts: [], writableMounts: [], tmpfsMounts: [], hiddenPaths: [], emptyHome: true, worktreeRoot: "/wt/a1" },
    network: { mode: "none" },
    environment: { variables: {}, inheritHost: false, locale: "C.UTF-8", pathEntries: [] },
    secrets: [],
    resources: { memoryMaxBytes: 64 * 1024, pidsMax: 16, wallTimeMs: 5000, stdoutMaxBytes: 1024, stderrMaxBytes: 1024, tmpfsMaxBytes: 1024 },
    cache: [],
    lifecycle: { killOnParentExit: true, cleanupOnExit: true, retainOnFailure: false, serviceMode: false },
    policyDigest: "",
    ...overrides,
  }
}

async function collect(spec: ExecutionCellSpec, broker: ReturnType<typeof createLinuxBroker>) {
  const events: Array<{ type: string; [k: string]: unknown }> = []
  for await (const e of broker.execute(spec)) events.push(e as unknown as { type: string; [k: string]: unknown })
  return events
}

describe("R2 broker transaction", () => {
  test("C5: sealed-file secrets leave no /tmp residue after execution", async () => {
    const { newSecretBinding } = await import("../../../src/runtime/linux/secrets")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { existsSync } = await import("node:fs")
    const binding = newSecretBinding({ purpose: "registry", delivery: "sealed-file", target: "/run/secrets/reg", expiresAt: Date.now() + 60_000 })
    const broker = createLinuxBroker({ mode: "enabled", secretValues: { [binding.id]: "s3cr3t" } })
    const events = await collect(cellSpec({ secrets: [binding] }), broker)
    expect(events.some(e => e.type === "cell.exit")).toBe(true)
    // C5（SECRET_TEMP_RESIDUE）：执行结束 → sealed secret 宿主文件与 root
    // 目录必须已删除（dispose 在事务 finally 触发，非"后端读取后清理"）
    const root = join(tmpdir(), `orcana-secrets-${process.pid}`)
    expect(existsSync(root)).toBe(false)
  })

  test("B7: receipt carries cleanupActions + secretRecords with verified revocation", async () => {
    const { newSecretBinding } = await import("../../../src/runtime/linux/secrets")
    const { mkdtempSync, rmSync, readdirSync, readFileSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { RuntimeStateStore } = await import("../../../src/runtime/linux/recovery/state-store")
    const binding = newSecretBinding({ purpose: "registry", delivery: "sealed-file", target: "/run/secrets/reg", expiresAt: Date.now() + 60_000 })
    const root = mkdtempSync(join(tmpdir(), "orcana-gate02-b7-"))
    try {
      const store = new RuntimeStateStore({ root })
      const broker = createLinuxBroker({ mode: "enabled", stateStore: store, secretValues: { [binding.id]: "s3cr3t" } })
      await collect(cellSpec({ secrets: [binding] }), broker)
      // 最终 Receipt 只持久化（stateStore.appendReceipt），事件流里的
      // cell.receipt 是后端原始版本 —— 从 store 读合并后的审计 receipt。
      const receiptsDir = join(root, "runs", "r1", "receipts")
      const files = readdirSync(receiptsDir)
      expect(files.length).toBeGreaterThan(0)
      const receipt = JSON.parse(readFileSync(join(receiptsDir, files[0]!), "utf8")) as import("../../../src/runtime/linux/contracts").SandboxReceipt
      // 统一清理动作：secret-file + secret-root（host-audit 无 seccomp 文件）
      expect(receipt.cleanupActions?.length).toBeGreaterThan(0)
      expect(receipt.cleanupActions!.some(a => a.kind === "secret-file" && a.ok)).toBe(true)
      // secret 交付生命周期：revokedAt 已落 + cleanupVerified 为真（文件已删）
      const records = receipt.secretRecords ?? []
      expect(records).toHaveLength(1)
      expect(records[0]!.leaseId).toBe(binding.id)
      expect(records[0]!.delivery).toBe("sealed-file")
      expect(records[0]!.revokedAt).toBeGreaterThan(0)
      expect(records[0]!.cleanupVerified).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("C5: failed secret binding cleans partially written files", async () => {
    const { newSecretBinding } = await import("../../../src/runtime/linux/secrets")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { existsSync } = await import("node:fs")
    // 先写有效 binding 再遇过期 binding → 绑定失败路径也必须清理已写文件
    const good = newSecretBinding({ purpose: "registry", delivery: "sealed-file", target: "/run/secrets/good", expiresAt: Date.now() + 60_000 })
    const expired = newSecretBinding({ purpose: "auth", delivery: "sealed-file", target: "/run/secrets/bad", expiresAt: Date.now() - 1000 })
    const broker = createLinuxBroker({ mode: "enabled", secretValues: { [good.id]: "g", [expired.id]: "x" } })
    await expect((async () => {
      for await (const _ of broker.execute(cellSpec({ secrets: [good, expired] }))) { /* drain */ }
    })()).rejects.toThrow(LinuxExecutionError)
    const root = join(tmpdir(), `orcana-secrets-${process.pid}`)
    expect(existsSync(root)).toBe(false)
  })


  test("execute reserves resources and releases them after completion", async () => {
    const ledger = new ResourceLedger({ maxConcurrentCells: 2, capacity: { cpuQuota: 1000, memoryBytes: 1024 * 1024, pids: 100, networkSlots: 1, tempBytes: 1024 * 1024, concurrentCells: 2 } })
    const broker = createLinuxBroker({ mode: "enabled", ledger })
    const events = await collect(cellSpec(), broker)
    expect(events.some(e => e.type === "cell.exit")).toBe(true)
    expect(events.some(e => e.type === "cell.receipt")).toBe(true)
    expect(ledger.outstanding().length).toBe(0)
  })

  test("resource exhaustion → RESOURCE_RESERVATION_FAILED before start", async () => {
    const ledger = new ResourceLedger({ maxConcurrentCells: 1, capacity: { cpuQuota: 1000, memoryBytes: 1024 * 1024, pids: 100, networkSlots: 1, tempBytes: 1024 * 1024, concurrentCells: 1 } })
    const broker = createLinuxBroker({ mode: "enabled", ledger })
    const hold = cellSpec({ command: { executable: "/bin/sh", args: ["-c", "sleep 3"], cwd: "/tmp", stdin: "closed" } })
    const p1 = (async () => { const events: unknown[] = []; for await (const e of broker.execute(hold)) events.push(e); return events })()
    await new Promise(r => setTimeout(r, 150))
    await expect((async () => {
      const second = cellSpec()
      for await (const _ of broker.execute(second)) { /* drain */ }
    })()).rejects.toThrow(LinuxExecutionError)
    const events = await p1
    expect(events.length).toBeGreaterThan(0)
  })

  test("isolation lock conflict rejects concurrent same-worktree cell", async () => {
    const broker = createLinuxBroker({ mode: "enabled" })
    // 同一 worktree 并发：第一个长跑（sleep），第二个在锁上失败。
    const lockSpec = cellSpec({
      command: { executable: "/bin/sh", args: ["-c", "sleep 3"], cwd: "/tmp", stdin: "closed" },
      filesystem: { readonlyMounts: [], writableMounts: [], tmpfsMounts: [], hiddenPaths: [], emptyHome: true, worktreeRoot: "/wt/same" },
    })
    const other = cellSpec({ filesystem: { readonlyMounts: [], writableMounts: [], tmpfsMounts: [], hiddenPaths: [], emptyHome: true, worktreeRoot: "/wt/same" } })
    const p1 = (async () => { for await (const _ of broker.execute(lockSpec)) { /* long running */ } })()
    await new Promise(r => setTimeout(r, 150))
    await expect((async () => {
      for await (const _ of broker.execute(other)) { /* drain */ }
    })()).rejects.toThrow(LinuxExecutionError)
    await p1
  })

  test("cgroup attach: cell cgroup created and pid attached (mock fs)", async () => {
    const fs = mockCgroupFs()
    const cgroup = new CgroupManager({ base: "/sys/fs/cgroup", fs })
    const broker = createLinuxBroker({ mode: "enabled", cgroup })
    const spec = cellSpec()
    const attached: number[] = []
    const orig = cgroup.attach.bind(cgroup)
    cgroup.attach = (pid: number, path: string) => { attached.push(pid); orig(pid, path) }
    const events: unknown[] = []
    for await (const e of broker.execute(spec)) events.push(e)
    expect(attached.length).toBeGreaterThanOrEqual(1)
    expect(events.some(e => (e as { type: string }).type === "cell.receipt")).toBe(true)
  })

  test("cancelRun releases ledger and records cancelled state", async () => {
    const ledger = new ResourceLedger({ maxConcurrentCells: 2, capacity: { cpuQuota: 1000, memoryBytes: 1024 * 1024, pids: 100, networkSlots: 1, tempBytes: 1024 * 1024, concurrentCells: 2 } })
    const broker = createLinuxBroker({ mode: "enabled", ledger })
    const controller = new AbortController()
    const spec = cellSpec({ command: { executable: "/bin/sh", args: ["-c", "sleep 30"], cwd: "/tmp", stdin: "closed" } })
    const run = (async () => { for await (const _ of broker.execute(spec, { abortSignal: controller.signal })) { /* drain */ } })()
    await new Promise(r => setTimeout(r, 150))
    controller.abort()
    await run
    await broker.cancelRun("r1")
    expect(ledger.outstanding().length).toBe(0)
    expect(broker.activeCells().length).toBe(0)
  })

  test("receipt cleanup is not assumed-safe: processesRemaining is measured", async () => {
    const fs = mockCgroupFs()
    const cgroup = new CgroupManager({ base: "/sys/fs/cgroup", fs })
    const broker = createLinuxBroker({ mode: "enabled", cgroup })
    const events = await collect(cellSpec(), broker)
    const receipt = events.find(e => e.type === "cell.receipt") as { receipt: { cleanup: { processesRemaining: number }; metrics: Record<string, unknown> } } | undefined
    expect(receipt).toBeDefined()
    expect(receipt!.receipt.cleanup.processesRemaining).toBeGreaterThanOrEqual(0)
    expect(typeof receipt!.receipt.metrics.cpuUsageUsec === "number" || receipt!.receipt.metrics.cpuUsageUsec === undefined).toBe(true)
  })

  test("PR-1: materialization reaches backend via ctx; compiled spec stays frozen", async () => {
    const fs = mockCgroupFs()
    const cgroup = new CgroupManager({ base: "/sys/fs/cgroup", fs })
    const broker = createLinuxBroker({ mode: "enabled", cgroup })
    const compiled = broker.compileSpec(cellSpec())
    // 编译产物深度冻结
    expect(Object.isFrozen(compiled)).toBe(true)
    expect(Object.isFrozen(compiled.environment.variables)).toBe(true)
    // 用包装后端捕获 ctx.materialization（缓存路径物化必须到达后端）。
    const { registerBackend } = await import("../../../src/runtime/linux/broker")
    const { createHostAuditBackend: makeAudit } = await import("../../../src/runtime/linux/backends/host-audit")
    let captured: { seccompFile?: string; cacheHostPaths?: Record<string, string> } | undefined
    const base = makeAudit()
    registerBackend({
      ...base,
      id: "host-audit",
      async *run(spec, ctx) {
        captured = { ...(ctx.materialization ?? {}), cacheHostPaths: ctx.materialization?.cacheHostPaths }
        yield* base.run(spec, ctx)
      },
    })
    const withCache = cellSpec({ cache: [{ cacheId: "c1", kind: "npm", key: "k1", mode: "ro", target: "/cache/npm" }] })
    for await (const _ of broker.execute(withCache)) { /* drain */ }
    expect(captured).toBeDefined()
    expect(captured!.cacheHostPaths?.["/cache/npm"]).toContain("cache")
  })

  test("PR-1: executeRequest compiles a CapabilityRequest and runs it", async () => {
    const broker = createLinuxBroker({ mode: "enabled" })
    const events: Array<{ type: string; [k: string]: unknown }> = []
    const authority = testAuthorityFallback(process.cwd())
    for await (const e of broker.executeRequest({
      command: { executable: "/bin/true", args: [] },
      profile: "build",
    }, { authority })) events.push(e as unknown as { type: string; [k: string]: unknown })
    expect(events.some(e => e.type === "cell.exit")).toBe(true)
    expect(events.some(e => e.type === "cell.receipt")).toBe(true)
    // 身份来自 Authority，非共享占位符
    expect((events[0] as { cellId?: string }).cellId?.startsWith("cell-")).toBe(true)
  })

  test("PR-2: receipt reflects real execution (duration > 0, measured cleanup)", async () => {
    const broker = createLinuxBroker({ mode: "enabled" })
    const spec = cellSpec({ command: { executable: "/bin/sh", args: ["-c", "sleep 0.2"], cwd: "/tmp", stdin: "closed" } })
    const events: Array<{ type: string; [k: string]: unknown }> = []
    for await (const e of broker.execute(spec)) events.push(e as unknown as { type: string; [k: string]: unknown })
    const receipt = events.find(e => e.type === "cell.receipt") as { receipt: { durationMs: number; startedAt: number; finishedAt: number; cleanup: { processesRemaining: number; cgroupRemoved: boolean }; receiptDigest: string } } | undefined
    expect(receipt).toBeDefined()
    // PR-2：真实执行时长（不再是被 Date.now() 双调用压成 ~0 的推定值）
    expect(receipt!.receipt.durationMs).toBeGreaterThan(100)
    expect(receipt!.receipt.finishedAt).toBeGreaterThan(receipt!.receipt.startedAt)
    // 清理实测：host-audit 下进程组扫描（sleep 已退出 → 0）
    expect(receipt!.receipt.cleanup.processesRemaining).toBe(0)
    // 自摘要存在且与摘要字段匹配
    expect(receipt!.receipt.receiptDigest.length).toBe(64)
  })

  test("PR-3: cancelCell aborts the running cell and the event stream ends", async () => {
    const broker = createLinuxBroker({ mode: "enabled" })
    const spec = cellSpec({ command: { executable: "/bin/sh", args: ["-c", "sleep 30"], cwd: "/tmp", stdin: "closed" } })
    const events: Array<{ type: string; [k: string]: unknown }> = []
    let cellId = ""
    const run = (async () => {
      for await (const e of broker.execute(spec)) {
        events.push(e as unknown as { type: string; [k: string]: unknown })
        if (e.type === "cell.status" && !cellId) cellId = e.cellId
      }
    })()
    await new Promise(r => setTimeout(r, 200))
    expect(broker.activeCells().length).toBe(1)
    await broker.cancelCell(cellId)
    await run
    // PR-3：cancelCell 主动触发 Supervisor abort → 事件流结束、cell 释放
    expect(events.some(e => e.type === "cell.exit")).toBe(true)
    const exit = events.find(e => e.type === "cell.exit") as { signal?: string | null } | undefined
    expect(exit?.signal).toBe("aborted")
    expect(broker.activeCells().length).toBe(0)
    // F4（ORPHAN_PROCESS）：cancelCell 后残留实测归零 —— receipt cleanup 是
    // 真实测量值（countProcessGroup），不是假定 0
    const receiptEvent = events.find(e => e.type === "cell.receipt") as { receipt?: { cleanup?: { processesRemaining?: number } } } | undefined
    expect(receiptEvent?.receipt?.cleanup?.processesRemaining).toBe(0)
  })

  test("PR-2: receipt is persisted to the state store", async () => {
    const { RuntimeStateStore } = await import("../../../src/runtime/linux/recovery/state-store")
    const root = (await import("node:fs")).mkdtempSync((await import("node:os")).tmpdir() + "/pr2-receipt-")
    try {
      const store = new RuntimeStateStore({ root })
      const broker = createLinuxBroker({ mode: "enabled", stateStore: store })
      const spec = cellSpec()
      for await (const _ of broker.execute(spec)) { /* drain */ }
      const runDir = store.runDir("r1")
      const receiptsDir = `${runDir}/receipts`
      const files = (await import("node:fs")).readdirSync(receiptsDir)
      expect(files.length).toBeGreaterThan(0)
      const persisted = JSON.parse((await import("node:fs")).readFileSync(`${receiptsDir}/${files[0]}`, "utf8"))
      expect(persisted.receiptDigest.length).toBe(64)
      expect(persisted.backend).toBe("host-audit")
    } finally {
      (await import("node:fs")).rmSync(root, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// IC02: acquisition transaction — fault injection（9 fault + 100 轮 seeded gate）
// ─────────────────────────────────────────────────────────────────────────────

import { hierarchyPaths } from "../../../src/runtime/linux/cgroup/manager"
import type { BrokerFaultPoint, BrokerTestHooks } from "../../../src/runtime/linux/broker"
import type { RuntimeStateStore } from "../../../src/runtime/linux/recovery/state-store"
import type { ExecutionBackend } from "../../../src/runtime/linux/backends/backend"

/** IC02：确定性 PRNG（mulberry32）—— 100 轮 fault gate 可复现。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeLedger(): ResourceLedger {
  return new ResourceLedger({ maxConcurrentCells: 4, capacity: { cpuQuota: 4000, memoryBytes: 4 * 1024 * 1024, pids: 400, networkSlots: 4, tempBytes: 4 * 1024 * 1024, concurrentCells: 4 } })
}

/** IC02：确定性 fault hook —— 只在指定 checkpoint 抛错一次。 */
function faultAtOnce(point: BrokerFaultPoint, message = "IC02-FAULT"): BrokerTestHooks {
  let fired = false
  return { faultAt: p => { if (!fired && p === point) { fired = true; return new Error(message) } return undefined } }
}

/** IC02：assertClean —— 每次 fault 后统一资源清洁检查。 */
async function assertClean(
  broker: ReturnType<typeof createLinuxBroker>,
  ledger: ResourceLedger,
  cgroup: CgroupManager | undefined,
  opts: { cgroupPaths?: string[] } = {},
): Promise<void> {
  expect(ledger.outstanding().length).toBe(0) // GHOST_RESERVATION = 0
  expect(broker.activeCells().length).toBe(0)  // WRONG_STATE = 0
  const locks = broker.runtimeContext().locks
  expect(locks.heldBy("worktree:a1")).toBeUndefined() // GHOST_LOCK = 0
  expect(locks.heldBy("main-workspace")).toBeUndefined()
  if (cgroup) {
    for (const p of opts.cgroupPaths ?? []) {
      expect(cgroup.fs.exists(p)).toBe(false) // GHOST_CGROUP = 0
    }
  }
}

describe("IC02 acquisition transaction — fault injection", () => {
  test("F1: materialize 之后抛错 → reservation/lock/materialization 全释放（sealed secret 无残留）", async () => {
    const { newSecretBinding } = await import("../../../src/runtime/linux/secrets")
    const { tmpdir } = await import("node:os")
    const { existsSync } = await import("node:fs")
    const binding = newSecretBinding({ purpose: "registry", delivery: "sealed-file", target: "/run/secrets/reg", expiresAt: Date.now() + 60_000 })
    const ledger = makeLedger()
    const broker = createLinuxBroker({
      mode: "enabled",
      ledger,
      testHooks: faultAtOnce("after-materialize"),
      secretValues: { [binding.id]: "s3cr3t" },
    })
    let caught: unknown = null
    try {
      for await (const _ of broker.execute(cellSpec({ secrets: [binding] }))) { /* drain */ }
    } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toMatch(/IC02-FAULT/)
    await assertClean(broker, ledger, undefined)
    // materialization 已 dispose：sealed secret root 不残留。
    const secretRoot = join(tmpdir(), `orcana-secrets-${process.pid}`)
    expect(existsSync(secretRoot)).toBe(false)
  })

  test("P1-1 regression: after-register-starting 抛错 → starting record 也由 cleanupAcquired 收尾", async () => {
    const ledger = makeLedger()
    const broker = createLinuxBroker({ mode: "enabled", ledger, testHooks: faultAtOnce("after-register-starting") })
    let caught: unknown = null
    try {
      for await (const _ of broker.execute(cellSpec())) { /* drain */ }
    } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(Error)
    await assertClean(broker, ledger, undefined)
  })

  test("F2: lock acquisition 失败（deterministic barrier，无 sleep）→ reservation 必须释放", async () => {
    const ledger = makeLedger()
    let barrierReached!: () => void
    const barrier = new Promise<void>(r => { barrierReached = r })
    let reached = false
    const hooks: BrokerTestHooks = {
      waitAt: p => { if (p === "after-lock" && !reached) { reached = true; barrierReached() } },
    }
    const broker = createLinuxBroker({ mode: "enabled", ledger, testHooks: hooks })
    const lockSpec = cellSpec({
      command: { executable: "/bin/sh", args: ["-c", "sleep 1"], cwd: "/tmp", stdin: "closed" },
      filesystem: { readonlyMounts: [], writableMounts: [], tmpfsMounts: [], hiddenPaths: [], emptyHome: true, worktreeRoot: "/wt/same" },
    })
    const other = cellSpec({ filesystem: { readonlyMounts: [], writableMounts: [], tmpfsMounts: [], hiddenPaths: [], emptyHome: true, worktreeRoot: "/wt/same" } })
    const p1 = (async () => { for await (const _ of broker.execute(lockSpec)) { /* hold */ } })()
    await barrier // 第一条已拿锁（after-lock checkpoint）——确定性同步点，无 sleep
    let caught: unknown = null
    try {
      for await (const _ of broker.execute(other)) { /* drain */ }
    } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(LinuxExecutionError)
    // 锁冲突 cell：reservation 已获取但锁失败 → reservation 必须已释放。
    expect(ledger.outstanding().length).toBe(1) // 只保留第一个 cell 的
    await p1
    expect(ledger.outstanding().length).toBe(0)
  })

  test("F3: createRun 部分创建后抛错（ensure 已 mkdir → controller 授权失败）→ run hierarchy 清理", async () => {
    const fs = mockCgroupFs()
    const origRead = fs.read.bind(fs)
    // createRun 内部顺序：ensure(run) 先 mkdir → requireControllers(run) 抛错。
    fs.read = (p) => {
      if (p.endsWith("cgroup.subtree_control") && p.includes("/run-")) throw new Error("CGROUP_CONTROLLER_UNAVAILABLE")
      return origRead(p)
    }
    const cgroup = new CgroupManager({ base: "/sys/fs/cgroup", fs })
    const ledger = makeLedger()
    const broker = createLinuxBroker({ mode: "enabled", ledger, cgroup })
    const spec = cellSpec()
    let caught: unknown = null
    try {
      for await (const _ of broker.execute(spec)) { /* drain */ }
    } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toMatch(/CGROUP_CONTROLLER_UNAVAILABLE/)
    // CGROUP_CONTROLLER_UNAVAILABLE 只可能发生在 ensure(run)（mkdir）之后 ——
    // run 目录确已被部分创建，cleanup 必须把它清掉（此处断言清理后不存在）。
    const run = hierarchyPaths(cgroup.base, "r1", undefined, "x").run
    await assertClean(broker, ledger, cgroup, { cgroupPaths: [run] })
  })

  test("F4: createAgent 部分创建后抛错（agent 目录已建 → 授权失败）→ run+agent 清理", async () => {
    const fs = mockCgroupFs()
    const origRead = fs.read.bind(fs)
    // createRun 正常；createAgent: ensure(agent) mkdir → requireControllers(agent) 抛错。
    fs.read = (p) => {
      if (p.endsWith("cgroup.subtree_control") && p.includes("/agent-")) throw new Error("CGROUP_CONTROLLER_UNAVAILABLE")
      return origRead(p)
    }
    const cgroup = new CgroupManager({ base: "/sys/fs/cgroup", fs })
    const ledger = makeLedger()
    const broker = createLinuxBroker({ mode: "enabled", ledger, cgroup })
    const spec = cellSpec()
    let caught: unknown = null
    try {
      for await (const _ of broker.execute(spec)) { /* drain */ }
    } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toMatch(/CGROUP_CONTROLLER_UNAVAILABLE/)
    // 授权失败发生在 ensure(agent)（mkdir）之后 —— agent 目录确已被部分创建。
    const run = hierarchyPaths(cgroup.base, "r1", undefined, "x").run
    const agent = join(run, "agent-a1")
    await assertClean(broker, ledger, cgroup, { cgroupPaths: [run, agent] })
  })

  test("F5: createCell 部分创建后抛错（cell 目录已建 → 属性写入失败）→ run+agent+cell 清理", async () => {
    const fs = mockCgroupFs()
    const origWrite = fs.write.bind(fs)
    // createCell: ensure(cell) mkdir → writeAttr(cell, cpu.max) 抛错。
    fs.write = (p, c) => {
      if (p.includes("/cell-")) throw new Error("EACCES")
      return origWrite(p, c)
    }
    const cgroup = new CgroupManager({ base: "/sys/fs/cgroup", fs })
    const ledger = makeLedger()
    const broker = createLinuxBroker({ mode: "enabled", ledger, cgroup })
    const spec = cellSpec()
    let caught: unknown = null
    try {
      for await (const _ of broker.execute(spec)) { /* drain */ }
    } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toMatch(/EACCES/)
    const run = hierarchyPaths(cgroup.base, "r1", undefined, "x").run
    const agent = join(run, "agent-a1")
    const cell = hierarchyPaths(cgroup.base, "r1", "a1", spec.identity.cellId).cell
    // EACCES 只可能发生在 ensure(cell)（mkdir）之后 —— cell 目录确已被部分创建，
    // cleanup 必须把它连同 run/agent 一起清掉（此处断言的是清理后不存在）。
    await assertClean(broker, ledger, cgroup, { cgroupPaths: [run, agent, cell] })
  })

  test("F6: backend compile throws → 已获取资源全释放（真实 backend.compile 抛错）", async () => {
    const { registerBackend } = await import("../../../src/runtime/linux/broker")
    const { createHostAuditBackend } = await import("../../../src/runtime/linux/backends/host-audit")
    const base = createHostAuditBackend()
    // 覆盖 host-audit：compile 抛错（backend.run 内部调用真实 compile path）。
    // 测试结束将 failCompile 置 false —— 同一覆盖对象恢复真实 compile 行为，
    // 不污染后续测试（registerBackend 无 unregister，闭包开关是唯一恢复通道）。
    let failCompile = true
    registerBackend({
      ...base,
      compile: (spec: unknown, caps: unknown, materialization?: unknown) => {
        if (failCompile) throw new Error("IC02-COMPILE-FAULT")
        return base.compile(spec as Parameters<typeof base.compile>[0], caps as Parameters<typeof base.compile>[1], materialization as Parameters<typeof base.compile>[2])
      },
    } as unknown as ExecutionBackend)
    const fs = mockCgroupFs()
    const cgroup = new CgroupManager({ base: "/sys/fs/cgroup", fs })
    const ledger = makeLedger()
    const broker = createLinuxBroker({ mode: "enabled", ledger, cgroup })
    const spec = cellSpec()
    let caught: unknown = null
    try {
      for await (const _ of broker.execute(spec)) { /* drain */ }
    } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toMatch(/IC02-COMPILE-FAULT/)
    const run = hierarchyPaths(cgroup.base, "r1", undefined, "x").run
    const cell = hierarchyPaths(cgroup.base, "r1", "a1", spec.identity.cellId).cell
    await assertClean(broker, ledger, cgroup, { cgroupPaths: [run, cell] })
    failCompile = false // 恢复真实 compile（不污染后续测试）
  })

  test("F7: backend start 失败（exitCode 127）→ 已获取资源全释放且失败证据确凿", async () => {
    const ledger = makeLedger()
    const broker = createLinuxBroker({ mode: "enabled", ledger })
    const spec = cellSpec({ command: { executable: "/nonexistent-orcana-ic02", args: [], cwd: "/tmp", stdin: "closed" } })
    const events: Array<{ type: string; receipt?: { exitCode?: number; process?: { exitCode?: number } } }> = []
    for await (const e of broker.execute(spec)) events.push(e as { type: string; receipt?: { exitCode?: number; process?: { exitCode?: number } } })
    const receipt = events.find(e => e.type === "cell.receipt")?.receipt
    // start failure 确实发生（exec 失败 → 127），而不是 fixture 未触发目标故障。
    expect(receipt?.process?.exitCode ?? receipt?.exitCode).toBe(127)
    await assertClean(broker, ledger, undefined)
  })

  test("F8: receipt persistence 抛错 → 不阻断 reservation/lock/registry 释放", async () => {
    const { RuntimeStateStore } = await import("../../../src/runtime/linux/recovery/state-store")
    const root = (await import("node:fs")).mkdtempSync((await import("node:os")).tmpdir() + "/ic02-receipt-fault-")
    try {
      const store = new RuntimeStateStore({ root })
      store.appendReceipt = () => { throw new Error("PERSIST-BOOM") }
      const ledger = makeLedger()
      const broker = createLinuxBroker({ mode: "enabled", ledger, stateStore: store })
      const events: unknown[] = []
      for await (const e of broker.execute(cellSpec())) events.push(e)
      expect(events.some(e => (e as { type: string }).type === "cell.receipt")).toBe(true)
      await assertClean(broker, ledger, undefined)
    } finally {
      (await import("node:fs")).rmSync(root, { recursive: true, force: true })
    }
  })

  test("F9: cancel during starting（barrier）→ controller abort 主通道、无 cgroup 也可 cancel、资源全释放", async () => {
    const fs = mockCgroupFs()
    const cgroup = new CgroupManager({ base: "/sys/fs/cgroup", fs })
    const ledger = makeLedger()
    let released = false
    const hooks: BrokerTestHooks = {
      waitAt: async (point) => {
        if (point === "after-register-starting" && !released) {
          released = true
          // 无 cgroup 依赖：cancelAgent 直接遍历 starting record → cancelCell。
          await broker.cancelAgent("a1")
        }
      },
    }
    const broker = createLinuxBroker({ mode: "enabled", ledger, cgroup, testHooks: hooks })
    const spec = cellSpec({ command: { executable: "/bin/sh", args: ["-c", "sleep 30"], cwd: "/tmp", stdin: "closed" } })
    // cancel 后事件流应尽快结束（abort 主通道生效），不要求抛错。
    const events: unknown[] = []
    for await (const e of broker.execute(spec)) events.push(e)
    expect(released).toBe(true)
    const run = hierarchyPaths(cgroup.base, "r1", undefined, "x").run
    const agent = join(run, "agent-a1")
    await assertClean(broker, ledger, cgroup, { cgroupPaths: [run, agent] })
  })

  test("run.json cells 保存真实 Cell ID（runId !== cellId 时不写 runId）", async () => {
    const { RuntimeStateStore } = await import("../../../src/runtime/linux/recovery/state-store")
    const { readFileSync, rmSync, mkdtempSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const root = mkdtempSync(tmpdir() + "/ic02-cellids-")
    try {
      const store = new RuntimeStateStore({ root })
      const ledger = makeLedger()
      const broker = createLinuxBroker({ mode: "enabled", ledger, stateStore: store })
      const specA = cellSpec({ identity: { cellId: "cell-a", runId: "run-xyz", nodeRunId: "run-xyz:n", attempt: 1, agentId: "a1" } })
      for await (const _ of broker.execute(specA)) { /* drain */ }
      const runState = JSON.parse(readFileSync(join(root, "runs", "run-xyz", "run.json"), "utf8")) as { cells: string[] }
      expect(runState.cells).toEqual(["cell-a"])
      expect(runState.cells).not.toContain("run-xyz") // RUN_STATE_CELL_ID_CORRUPTION = 0
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("IC02 100-run fault gate: 9 mandatory fault categories seeded 随机 → RESOURCE_LEAK/LOCK_LEAK/WRONG_STATE = 0", async () => {
    const { RuntimeStateStore } = await import("../../../src/runtime/linux/recovery/state-store")
    const { createHostAuditBackend } = await import("../../../src/runtime/linux/backends/host-audit")
    const { registerBackend } = await import("../../../src/runtime/linux/broker")
    const { mkdtempSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const storeRoot = mkdtempSync(tmpdir() + "/ic02-100run-")
    // backend compile 共享开关（覆盖 host-audit，仅在 compile category 轮抛错）。
    const hostAuditBase = createHostAuditBackend()
    let compileFail = false
    registerBackend({
      ...hostAuditBase,
      compile: (spec: unknown, caps: unknown, materialization?: unknown) => {
        if (compileFail) throw new Error("IC02-COMPILE-FAULT")
        return hostAuditBase.compile(spec as Parameters<typeof hostAuditBase.compile>[0], caps as Parameters<typeof hostAuditBase.compile>[1], materialization as Parameters<typeof hostAuditBase.compile>[2])
      },
    } as unknown as ExecutionBackend)

    type Category = {
      name: string
      /** 轮内准备（fs/cgroup/ledger/hooks/stateStore）。 */
      prepare: (fs: CgroupFs, cgroup: CgroupManager, round: number) => { hooks?: BrokerTestHooks; spec?: ExecutionCellSpec; preLock?: boolean; failPersist?: boolean }
    }
    const categories: Category[] = [
      { name: "materialize-throws", prepare: () => ({ hooks: faultAtOnce("after-materialize", `IC02-ROUND`) }) },
      { name: "lock-acquisition-fails", prepare: () => ({ preLock: true }) },
      { name: "createRun-partial", prepare: (fs) => {
        const orig = fs.read.bind(fs)
        fs.read = (p) => { if (p.endsWith("cgroup.subtree_control") && p.includes("/run-")) throw new Error("CGROUP_CONTROLLER_UNAVAILABLE"); return orig(p) }
        return {}
      } },
      { name: "createAgent-partial", prepare: (fs) => {
        const orig = fs.read.bind(fs)
        fs.read = (p) => { if (p.endsWith("cgroup.subtree_control") && p.includes("/agent-")) throw new Error("CGROUP_CONTROLLER_UNAVAILABLE"); return orig(p) }
        return {}
      } },
      { name: "createCell-partial", prepare: (fs) => {
        const orig = fs.write.bind(fs)
        fs.write = (p, c) => { if (p.includes("/cell-")) throw new Error("EACCES"); return orig(p, c) }
        return {}
      } },
      { name: "backend-compile", prepare: () => { compileFail = true; return {} } },
      { name: "backend-start", prepare: () => ({ spec: cellSpec({ command: { executable: "/nonexistent-orcana-ic02", args: [], cwd: "/tmp", stdin: "closed" } }) }) },
      { name: "receipt-persist", prepare: () => ({ failPersist: true }) },
      { name: "cancel-starting", prepare: (fs, cgroup, round) => {
        let released = false
        return { hooks: { waitAt: async (point) => {
          if (point === "after-register-starting" && !released) {
            released = true
            // 无 cgroup 依赖：starting record 可被 cancelAgent 找到。
            await cancelTarget.cancelAgent("a1")
          }
        } } }
      } },
    ]

    const rand = mulberry32(20260810)
    let cancelTarget: ReturnType<typeof createLinuxBroker>
    for (let round = 0; round < 100; round++) {
      const category = categories[Math.floor(rand() * categories.length)]!
      const fs = mockCgroupFs()
      const cgroup = new CgroupManager({ base: "/sys/fs/cgroup", fs })
      const ledger = makeLedger()
      const prep = category.prepare(fs, cgroup, round)
      const store = new RuntimeStateStore({ root: storeRoot })
      if (prep.failPersist) store.appendReceipt = () => { throw new Error("PERSIST-BOOM") }
      const broker = createLinuxBroker({ mode: "enabled", ledger, cgroup, stateStore: store, testHooks: prep.hooks })
      cancelTarget = broker
      if (prep.preLock) {
        // deterministic lock 竞争：先占 worktree 锁（broker 内 locks 实例）。
        broker.runtimeContext().locks.acquire("worktree:a1", "exclusive", "ic02-100run-holder")
      }
      try {
        for await (const _ of broker.execute(prep.spec ?? cellSpec())) { /* drain */ }
      } catch (error) {
        expect(error instanceof Error).toBe(true)
      }
      compileFail = false // backend-compile 开关只影响本轮
      if (prep.preLock) {
        // 释放测试自持的"外部竞争者"锁（模拟其他 agent 的合法持有；
        // broker 自己的 lockKeys 已由 cleanupAcquired 释放）。
        broker.runtimeContext().locks.release("worktree:a1", "ic02-100run-holder")
      }
      expect(ledger.outstanding().length).toBe(0) // RESOURCE_LEAK = 0
      expect(broker.activeCells().length).toBe(0)  // WRONG_STATE = 0
      const locks = broker.runtimeContext().locks
      expect(locks.heldBy("worktree:a1")).toBeUndefined() // LOCK_LEAK = 0
      expect(locks.heldBy("main-workspace")).toBeUndefined()
      const run = hierarchyPaths(cgroup.base, "r1", undefined, "x").run
      expect(cgroup.fs.exists(run)).toBe(false) // GHOST_CGROUP = 0
    }
    rmSync(storeRoot, { recursive: true, force: true })
  }, 120_000)
})
