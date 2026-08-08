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
      server.publishEvent({ kind: "lease.expired", cellId: "", runId, payload: { leaseId } }, state.latestEventSequence() + 1)
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
    renewLease: leaseId => Promise.resolve(leaseManager.renew(leaseId, 60_000)),
    releaseLease: leaseId => Promise.resolve(leaseManager.release(leaseId)),
    listRecoverableRuns: () => cellManager.listRecoverableRuns(),
  }
  const server = new ExecdServer(deps)

  // 事件广播接线：CellManager/Recovery 的 publish → server 广播。
  cellManager.setPublisher((event, sequence) => server.publishEvent({ ...event, cellId: event.cellId ?? "" }, sequence))

  let started = false
  const start = async (): Promise<void> => {
    await server.start()
    // 启动恢复：收敛崩溃残留（SAME_BOOT_CRASH_UNRECOVERED = 0）。
    const report = recovery.run()
    if (report.scanned > 0) {
      for (const r of report.recovered) {
        server.publishEvent({ kind: "recovery", cellId: r.cellId, payload: { from: r.from, to: r.to, reason: r.reason } }, state.latestEventSequence())
      }
    }
    started = true
  }
  const stop = async (): Promise<void> => {
    await server.stop()
    state.close()
    started = false
  }
  return { state, cellManager, leaseManager, recovery, server, start, stop }
}
