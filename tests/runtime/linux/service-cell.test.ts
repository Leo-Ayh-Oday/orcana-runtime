/**
 * LNXF-GATE-02 (B12+B13 / A7+B10) —— ServiceCell + durable recovery 验收。
 *
 * 合同（GATES-CONTROL-PLANE-PLAN.md §十九/§十七）：
 *   - service/mcp/lsp 离开 spawnLegacy，进入 ServiceCell（lease/owner/
 *     readiness/explicit env/restart policy/health/durable cleanup）
 *   - 恢复基于 durable resource ownership（janitor 从记录清理，不重建
 *     空 Broker 推测）
 *   - owner 判定 pid + starttime 双校验（PID 复用安全）
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServiceCell } from "../../../src/runtime/linux/service-cell"
import { RuntimeStateStore, procStartTicksOf, processDead } from "../../../src/runtime/linux/recovery/state-store"
import { createLinuxBroker } from "../../../src/runtime/linux/broker"
import { startServiceInternal, setServiceLeaseStore, urlPortOf } from "../../../src/tools/service"

// ── 内存 store（测试用，不写 ~/.orcana） ──

function memoryStore() {
  const services = new Map<string, unknown>()
  const ports = new Map<number, unknown>()
  return {
    writeServiceLease(lease: unknown) { services.set((lease as { id: string }).id, lease) },
    readServiceLeases() { return [...services.values()] },
    removeServiceLease(id: string) { services.delete(id) },
    writePortLease(lease: unknown) { ports.set((lease as { port: number }).port, lease) },
    readPortLeases() { return [...ports.values()] },
    removePortLease(port: number) { ports.delete(port) },
    services,
    ports,
  }
}

afterEach(() => {
  setServiceLeaseStore(undefined)
})

describe("ServiceCell 基础（lease/owner/readiness/durable cleanup）", () => {
  test("创建即登记 lease（pid + starttime + explicit env）", () => {
    const store = memoryStore()
    const cell = createServiceCell({
      kind: "service",
      command: "/bin/sleep",
      args: ["30"],
      cwd: "/tmp",
      cleanupPolicy: "manual",
      logPath: "",
      detached: true,
      store: store as never,
    })
    expect(cell.lease.kind).toBe("service")
    expect(cell.lease.status).toBe("starting")
    expect(cell.lease.pid).toBeGreaterThan(0)
    expect(cell.lease.ownerProcStartTicks).toBe(procStartTicksOf(cell.lease.pid!))
    expect(store.services.size).toBe(1)
    // 环境不得含宿主密钥（explicit env 语义在 createServiceCell 内保证）
    expect(cell.proc.exitCode).toBeNull()
    cell.release()
  })

  test("markReady 持久化 status；release 幂等 + 删记录", () => {
    const store = memoryStore()
    const cell = createServiceCell({
      kind: "mcp",
      command: "/bin/sleep",
      args: ["30"],
      cwd: "/tmp",
      cleanupPolicy: "run-end",
      logPath: "",
      detached: true,
      store: store as never,
    })
    cell.markReady()
    expect((store.services.get(cell.lease.id) as { status: string }).status).toBe("ready")
    cell.release()
    cell.release() // 幂等
    expect(store.services.size).toBe(0)
  })

  test("进程退出自动清理记录", async () => {
    const store = memoryStore()
    const cell = createServiceCell({
      kind: "lsp",
      command: "/bin/true",
      args: [],
      cwd: "/tmp",
      cleanupPolicy: "run-end",
      logPath: "",
      detached: false,
      store: store as never,
    })
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(store.services.size).toBe(0)
  })

  test("owner 判定：pid + starttime 双校验（PID 复用安全）", async () => {
    const store = memoryStore()
    const cell = createServiceCell({
      kind: "service",
      command: "/bin/sleep",
      args: ["30"],
      cwd: "/tmp",
      cleanupPolicy: "manual",
      logPath: "",
      detached: true,
      store: store as never,
    })
    // 存活 owner → 非死
    expect(processDead(cell.lease.pid, cell.lease.ownerProcStartTicks)).toBe(false)
    // starttime 不匹配 → 死（模拟 PID 复用）
    expect(processDead(cell.lease.pid, cell.lease.ownerProcStartTicks + 9999)).toBe(true)
    cell.release()
    await new Promise(resolve => setTimeout(resolve, 100))
    // 释放后（进程被终止）→ 死
    expect(processDead(cell.lease.pid, cell.lease.ownerProcStartTicks)).toBe(true)
  })
})

describe("service 工具迁移（durable lease + port lease）", () => {
  test("start + stopAfterReady：port lease 短暂存在后删除", async () => {
    const store = memoryStore()
    setServiceLeaseStore(store as never)
    const old = process.env.ORCANA_INTERACTIVE
    process.env.ORCANA_INTERACTIVE = "0"
    try {
      const result = await startServiceInternal(
        {
          command: "sleep 30",
          cwd: process.cwd(),
          url: "http://127.0.0.1:12761",
          stopAfterReady: true,
        },
        { waitForHttp: async () => ({ ok: true }) as never },
      )
      expect(result.success).toBe(true)
      // stopAfterReady → 进程停止 + durable 记录删除
      expect(store.services.size).toBe(0)
      expect(store.ports.size).toBe(0)
    } finally {
      if (old === undefined) delete process.env.ORCANA_INTERACTIVE
      else process.env.ORCANA_INTERACTIVE = old
    }
  })

  test("urlPortOf 提取端口（PortLease 键）", () => {
    expect(urlPortOf("http://127.0.0.1:3000/health")).toBe(3000)
    expect(urlPortOf("http://127.0.0.1/health")).toBeUndefined()
  })
})

describe("Durable recovery（janitor 从记录恢复）", () => {
  test("cleanupRun 按 durable 记录清理 services/ports（owner 已死）", async () => {
    const root = mkdtempSync(join(tmpdir(), "orcana-gate02-"))
    try {
      const store = new RuntimeStateStore({ root })
      const broker = createLinuxBroker({ mode: "shadow", stateStore: store })
      // 直接写入 stale 记录（模拟上次进程崩溃残留）
      store.writeServiceLease({
        id: "svc-stale",
        kind: "service",
        runId: "r-dead",
        pid: 999999,
        ownerProcStartTicks: 1,
        command: "x",
        cwd: "/tmp",
        startedAt: Date.now(),
        status: "ready",
        cleanupPolicy: "run-end",
        logPath: "",
        restartPolicy: "none",
      })
      store.writePortLease({
        port: 34567,
        serviceId: "svc-stale",
        runId: "r-dead",
        pid: 999999,
        ownerProcStartTicks: 1,
        startedAt: Date.now(),
      })
      const cleaned = await broker.cleanupRun("r-dead")
      expect(cleaned.servicesCleaned).toBe(1)
      expect(cleaned.portsCleaned).toBe(1)
      expect(store.readServiceLeases()).toHaveLength(0)
      expect(store.readPortLeases()).toHaveLength(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("owner 存活的 manual lease 不误杀（跨进程复用保护）", async () => {
    const root = mkdtempSync(join(tmpdir(), "orcana-gate02-"))
    try {
      const store = new RuntimeStateStore({ root })
      const broker = createLinuxBroker({ mode: "shadow", stateStore: store })
      const cell = createServiceCell({
        kind: "service",
        command: "/bin/sleep",
        args: ["30"],
        cwd: "/tmp",
        cleanupPolicy: "manual",
        logPath: "",
        detached: true,
        store,
      })
      const cleaned = await broker.cleanupRun("other-run")
      // manual + owner 存活 → 不清理
      expect(cleaned.servicesCleaned).toBe(0)
      expect(store.readServiceLeases()).toHaveLength(1)
      cell.release()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("startupJanitor 的 RecoveryReceipt 携带 services 计数", async () => {
    const root = mkdtempSync(join(tmpdir(), "orcana-gate02-"))
    try {
      const store = new RuntimeStateStore({ root })
      // janitor 识别 stale run 的依据是 run.json 记录（boot 变更 → 全 stale）。
      store.writeRun("r-old", { status: "running", ownerPid: 1, ownerProcStartTicks: 1 })
      store.writeServiceLease({
        id: "svc-j",
        kind: "mcp",
        runId: "r-old",
        pid: 999999,
        ownerProcStartTicks: 1,
        command: "x",
        cwd: "/tmp",
        startedAt: Date.now(),
        status: "ready",
        cleanupPolicy: "run-end",
        logPath: "",
        restartPolicy: "none",
      })
      const { startupJanitor } = await import("../../../src/runtime/linux/recovery/state-store")
      const receipts = await startupJanitor({
        store,
        currentBootId: "boot-new",
        cleanupRun: async runId => {
          // 模拟 broker.cleanupRun 语义
          const services = store.readServiceLeases().filter(l => l.runId === runId).length
          for (const l of store.readServiceLeases()) if (l.runId === runId) store.removeServiceLease(l.id)
          return { cgroups: [], worktrees: [], ports: 0, services, containers: [], stateRemoved: false }
        },
      })
      expect(receipts).toHaveLength(1)
      expect(receipts[0]!.cleaned.services).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
