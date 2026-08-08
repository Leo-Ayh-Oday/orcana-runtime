/** LR2-1（L1-G）：execd 组装 —— StateStore + Broker + CellManager +
 *  LeaseManager + Recovery + Server 的依赖装配（可测试）。
 *
 *  启动顺序（LR2-1 §7）：1) StateStore 打开（WAL）→ 2) 组装组件 →
 *  3) Recovery 扫描收敛崩溃残留 → 4) Server 监听。
 */

import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { StateStore } from "./state/store"
import { CellManager } from "./cell-manager"
import { LeaseManager } from "./lease-manager"
import { Recovery } from "./recovery"
import { ExecdServer, type ExecdServerDeps } from "./server"
import { createLinuxBroker, type LinuxExecutionBroker } from "../runtime/linux/broker"

/** M3：租约过期扫描间隔（daemon 常驻定时器）。 */
const LEASE_SWEEP_INTERVAL_MS = 30_000

export interface ExecdOptions {
  sockPath: string
  statePath: string
  workspaceHostRoot: string
  broker?: LinuxExecutionBroker
}

export interface Execd {
  state: StateStore
  cellManager: CellManager
  leaseManager: LeaseManager
  recovery: Recovery
  server: ExecdServer
  start(): Promise<void>
  stop(): Promise<void>
}

export function createExecd(opts: ExecdOptions): Execd {
  if (process.platform !== "linux") {
    throw new Error("orcana-execd is Linux-only")
  }
  mkdirSync(dirname(opts.statePath), { recursive: true, mode: 0o700 })
  const state = new StateStore(opts.statePath)
  const broker = opts.broker ?? createLinuxBroker({ mode: "enabled" })

  const cellManager = new CellManager({
    state,
    broker,
    workspaceHostRoot: opts.workspaceHostRoot,
    publish: () => { /* 事件广播由 server 组装后接线 */ },
  })
  const leaseManager = new LeaseManager({
    state,
    onExpired: (leaseId, runId) => {
      // M4 修复：租约过期事件也落库（统一序号空间，可断点续读）。
      const seq = state.appendStreamEvent({ cellId: "", attemptId: "", kind: "exit", payload: JSON.stringify({ leaseId, runId, event: "lease.expired" }) })
      server.publishEvent({ kind: "lease.expired", cellId: "", runId, payload: { leaseId } }, seq)
    },
  })
  const recovery = new Recovery({
    state,
    publish: (event, sequence) => server.publishEvent({ ...event, cellId: event.cellId ?? "" }, sequence),
  })

  const deps: ExecdServerDeps = {
    sockPath: opts.sockPath,
    state,
    submitCell: (payload, idempotencyKey, sessionId) => cellManager.submit(payload, idempotencyKey, sessionId),
    getCell: cellId => cellManager.getCell(cellId),
    cancelCell: cellId => cellManager.cancelCell(cellId),
    cancelAgent: agentId => cellManager.cancelAgent(agentId),
    cancelRun: runId => cellManager.cancelRun(runId),
    cleanupRun: runId => cellManager.cleanupRun(runId),
    acquireLease: (runId, ttlMs) => Promise.resolve(leaseManager.acquire(runId, ttlMs)),
    // M9 修复：renew 透传客户端 ttlMs（不再静默丢弃）。
    renewLease: (leaseId, ttlMs) => Promise.resolve(leaseManager.renew(leaseId, ttlMs)),
    releaseLease: leaseId => Promise.resolve(leaseManager.release(leaseId)),
    listRecoverableRuns: () => cellManager.listRecoverableRuns(),
  }
  const server = new ExecdServer(deps)

  // 事件广播接线：CellManager/Recovery 的 publish → server 广播。
  cellManager.setPublisher((event, sequence) => server.publishEvent({ ...event, cellId: event.cellId ?? "" }, sequence))

  let started = false
  let leaseSweepTimer: ReturnType<typeof setInterval> | undefined

  const start = async (): Promise<void> => {
    await server.start()
    // 启动恢复：收敛崩溃残留（SAME_BOOT_CRASH_UNRECOVERED = 0）。
    // M15：recovery.run 内部已按分支广播（不再此处重播）。
    recovery.run()
    // M3 修复：租约过期扫描常驻定时器（daemon 运行期间租约必须真实过期）。
    leaseSweepTimer = setInterval(() => {
      try {
        leaseManager.sweepExpired()
      } catch (error) {
        // 扫描失败不崩溃 daemon（记录到 stderr，systemd journal）。
        console.error(`[execd] lease sweep failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }, LEASE_SWEEP_INTERVAL_MS)
    started = true
  }
  const stop = async (): Promise<void> => {
    // M2 修复：先取消在途 cell 并等待收尾（进程真实终止），再关 server
    // 与 DB —— 否则在途 runCell 写已关闭 DB 崩溃 daemon。
    await cellManager.stop()
    if (leaseSweepTimer) clearInterval(leaseSweepTimer)
    await server.stop()
    state.close()
    started = false
  }
  return { state, cellManager, leaseManager, recovery, server, start, stop }
}
