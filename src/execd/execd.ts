/** LR2-1（L1-G）：execd 组装 —— StateStore + Broker + CellManager +
 *  LeaseManager + Recovery + Server 的依赖装配（可测试）。
 *
 *  启动顺序（LR2-1 §7）：1) StateStore 打开（WAL）→ 2) 组装组件 →
 *  3) Recovery 扫描收敛崩溃残留 → 4) Server 监听。
 */

import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { StateStore } from "./state/store"
import { CellManager } from "./cell-manager"
import { LeaseManager } from "./lease-manager"
import { Recovery } from "./recovery"
import { ExecdServer, type ExecdServerDeps } from "./server"
import { LogStore } from "./log-store"
import { createLinuxBroker, type LinuxExecutionBroker } from "../runtime/linux/broker"
import { createHostCapacityAuthority, readProcessStartticks } from "../runtime/linux/scheduler/host-capacity"
import { envApprovalTokenProvider, type ApprovalTokenProvider } from "./approval"

/** M3：租约过期扫描间隔（daemon 常驻定时器）。 */
const LEASE_SWEEP_INTERVAL_MS = 30_000

/** IC06 修复（P1-2）：容量 reconcile 周期（daemon 常驻定时器）。
 *  仅启动时 reconcile 一次会让 QUARANTINED/SUSPECT（release 时进程恰好
 *  活着 / reality 暂不可读）的 claim 一直占用容量直到 daemon 重启；
 *  周期 reconcile 使已死进程的 claim 在下一周期内释放。
 *  可用 ORCANA_EXECD_CAPACITY_RECONCILE_MS 覆盖（0 = 禁用）。 */
const CAPACITY_RECONCILE_INTERVAL_MS = (() => {
  const raw = process.env.ORCANA_EXECD_CAPACITY_RECONCILE_MS
  if (raw === undefined) return 60_000
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : 60_000
})()

export interface ExecdOptions {
  sockPath: string
  statePath: string
  workspaceHostRoot: string
  broker?: LinuxExecutionBroker
  /** L2-D：approval token 源（缺省读 env —— fail closed）。 */
  approval?: ApprovalTokenProvider
  /** L2-B：大对象日志根目录（缺省 $TMPDIR/orcana-execd/logs）。 */
  logRoot?: string
  /** IC06：authority 并发 Cell 上限（缺省 6；测试可注入小值）。 */
  capacityMaxConcurrentCells?: number
}

export interface Execd {
  state: StateStore
  cellManager: CellManager
  leaseManager: LeaseManager
  recovery: Recovery
  server: ExecdServer
  /** IC06：authority object（in-process 视图 —— 供测试/维护）。 */
  authority: import("../runtime/linux/scheduler/host-capacity").HostCapacityAuthority
  start(): Promise<void>
  stop(): Promise<void>
}

export function createExecd(opts: ExecdOptions): Execd {
  if (process.platform !== "linux") {
    throw new Error("orcana-execd is Linux-only")
  }
  mkdirSync(dirname(opts.statePath), { recursive: true, mode: 0o700 })
  const state = new StateStore(opts.statePath)

  // IC06：Authority bootstrap —— server-side HostCapacityAuthority 先于
  // 一切执行路径创建（AUTHORITY_SELF_BOOTSTRAP_CYCLE=0：execd 内部不经
  // socket self-RPC，broker 直接注入同一 in-process object）。
  const authority = createHostCapacityAuthority({
    dbPath: join(dirname(opts.statePath), "capacity.db"),
    maxConcurrentCells: opts.capacityMaxConcurrentCells,
  })
  const broker = opts.broker ?? createLinuxBroker({ mode: "enabled", capacityAuthority: authority })

  // L2-B（B2 修复）：大对象日志落盘（AttachLogs 回放源；索引在 SQLite）。
  const logStore = new LogStore({
    logRoot: opts.logRoot ?? join(join(tmpdir(), "orcana-execd"), "logs"),
    index: {
      upsert: row => state.upsertLogIndex(row),
      get: (cellId, kind) => state.getLogIndex(cellId, kind) as import("./log-store").LogIndexRow | undefined,
      remove: cellId => state.deleteLogIndex(cellId),
    },  })

  const cellManager = new CellManager({
    state,
    broker,
    workspaceHostRoot: opts.workspaceHostRoot,
    logStore,
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
    // IC06（P0-7）：RECOVERED live cell 记账（recovery 内 charge，admission 前）。
    capacity: authority,
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
    attachLogs: (cellId, kind, offset) => logStore.attach(cellId, kind, offset),
    // IC06：capacity.* Hard Authority 路由（同一 in-process object）。
    capacity: authority,
  }
  const server = new ExecdServer(deps, undefined, undefined, opts.approval ?? envApprovalTokenProvider())

  // 事件广播接线：CellManager/Recovery 的 publish → server 广播。
  cellManager.setPublisher((event, sequence) => server.publishEvent({ ...event, cellId: event.cellId ?? "" }, sequence))

  let started = false
  let leaseSweepTimer: ReturnType<typeof setInterval> | undefined
  let capacityReconcileTimer: ReturnType<typeof setInterval> | undefined

  const start = async (): Promise<void> => {
    // IC06（P0-7）：authority reconcile → Recovery（含 RECOVERED live cell
    // 记账）→ 全部 recovered occupancy charged → 才开放外部 admission
    // （EXECD_ADMISSION_BEFORE_RECOVERY_CHARGE=0 / RECOVERED_LIVE_CELL_
    // ADMISSION_BYPASS=0）。recovery.publish 在 server 未监听时安全（无连接）。
    await authority.reconcile({
      uid: process.getuid?.() ?? -1,
      pid: process.pid,
      startticks: readProcessStartticks(process.pid) ?? 0,
      clientInstanceId: `execd-${process.pid}`,
    })
    // 启动恢复：收敛崩溃残留（SAME_BOOT_CRASH_UNRECOVERED = 0）。
    // M15：recovery.run 内部已按分支广播（不再此处重播）。
    recovery.run()
    await server.start()
    // M3 修复：租约过期扫描常驻定时器（daemon 运行期间租约必须真实过期）。
    leaseSweepTimer = setInterval(() => {
      try {
        leaseManager.sweepExpired()
      } catch (error) {
        // 扫描失败不崩溃 daemon（记录到 stderr，systemd journal）。
        console.error(`[execd] lease sweep failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }, LEASE_SWEEP_INTERVAL_MS)
    // IC06 修复（P1-2）：周期容量 reconcile —— 已死进程的
    // QUARANTINED/SUSPECT claim 在下一周期内释放，长驻 daemon 不枯竭。
    if (CAPACITY_RECONCILE_INTERVAL_MS > 0) {
      capacityReconcileTimer = setInterval(() => {
        authority.reconcile({
          uid: process.getuid?.() ?? -1,
          pid: process.pid,
          startticks: readProcessStartticks(process.pid) ?? 0,
          clientInstanceId: `execd-sweep-${process.pid}`,
        }).catch(error => {
          // reconcile 失败不崩溃 daemon（下一周期重试）。
          console.error(`[execd] capacity reconcile sweep failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      }, CAPACITY_RECONCILE_INTERVAL_MS)
    }
    started = true
  }
  const stop = async (): Promise<void> => {
    // M2 修复：先取消在途 cell 并等待收尾（进程真实终止），再关 server
    // 与 DB —— 否则在途 runCell 写已关闭 DB 崩溃 daemon。
    await cellManager.stop()
    if (leaseSweepTimer) clearInterval(leaseSweepTimer)
    if (capacityReconcileTimer) clearInterval(capacityReconcileTimer)
    await server.stop()
    state.close()
    await authority.close()
    started = false
  }
  return { state, cellManager, leaseManager, recovery, server, authority, start, stop }
}
