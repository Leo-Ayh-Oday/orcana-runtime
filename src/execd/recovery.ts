/** LR2-1v2（L2-A）：Recovery —— 启动恢复（非终态 Attempt 扫描 + 接管）。
 *
 *  恢复动作表（主计划 LR2-1 §7，v2 适配）：
 *  - RUNNING + 有执行句柄（cgroup）→ 探活接管：
 *    - cgroup populated=1 → 进程树仍活着 → 保持 RUNNING（重新接管监控，
 *      取消/超时走 cgroup 路径 —— EXECD_RESTART_LOSES_RUNNING_CELL = 0）；
 *    - cgroup populated=0 → 树已退出 → 收敛 EXIT_OBSERVED；
 *    - cgroup 不存在 → 收敛 START_FAILED（未启动/已清理）。
 *  - ACCEPTED / POLICY_COMPILED（无句柄）→ LOST（如实记录）；
 *  - EXIT_OBSERVED：无 Receipt → Recovery Receipt（unobserved）；
 *  - RECEIPT_COMMITTED：无 Evidence → 广播重绑定；
 *  - CLEANUP_PENDING：幂等继续清理；
 *  - SIDE_EFFECT_UNKNOWN：不盲跑（UNKNOWN_SIDE_EFFECT_BLIND_RETRY = 0）。
 *
 *  同 boot 崩溃恢复：SAME_BOOT_CRASH_UNRECOVERED = 0 —— 每次启动扫描
 *  全部非终态 Attempt 并收敛（同一开机内的多次崩溃同样处理）。
 */

import { StateStore, type CellRecord, type CellState } from "./state/store"
import { determineTakeover, type CgroupProbeFs, REAL_CGROUP_PROBE_FS } from "./handle"

export interface RecoveryOptions {
  state: StateStore
  /** 事件广播（server.publishEvent）。 */
  publish: (event: { kind: string; cellId: string; runId?: string; payload?: unknown }, sequence: number) => void
  /** cgroup 探活 fs（测试注入；默认真实）。 */
  probeFs?: CgroupProbeFs
  now?: () => number
  /** IC06（P0-7）：CapacityAuthority —— RECOVERED live cell 必须记账
   *  （无 claim → 保守 QUARANTINED charge；admission 前完成）。 */
  capacity?: import("../runtime/linux/scheduler/host-capacity").HostCapacityAuthority
}

export interface RecoveryReport {
  scanned: number
  recovered: Array<{ cellId: string; from: CellState; to: CellState; reason: string }>
}

export class Recovery {
  private readonly probeFs: CgroupProbeFs

  constructor(private readonly opts: RecoveryOptions) {
    this.probeFs = opts.probeFs ?? REAL_CGROUP_PROBE_FS
  }

  private get now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  run(): RecoveryReport {
    const state = this.opts.state
    const scanned = state.listNonTerminalCells()
    const report: RecoveryReport = { scanned: scanned.length, recovered: [] }
    for (const cell of scanned) {
      const attemptId = `${cell.cellId}-a${cell.attempt}`
      const action = this.recover(cell, attemptId)
      report.recovered.push({ cellId: cell.cellId, from: cell.currentState, to: action.to, reason: action.reason })
    }
    return report
  }

  private recover(cell: CellRecord, attemptId: string): { to: CellState; reason: string } {
    const state = this.opts.state
    const at = this.now
    switch (cell.currentState) {
      case "ACCEPTED":
      case "POLICY_COMPILED": {
        // 未启动到 cgroup 阶段（无句柄可接管）→ LOST（如实记录）。
        state.withTransaction(() => {
          state.transition(cell.cellId, attemptId, "LOST", { from: cell.currentState, reasonCode: "execd-restart-untracked", actor: "recovery", at })
        })
        this.opts.publish({ kind: "recovery", cellId: cell.cellId, runId: cell.runId, payload: { from: cell.currentState, to: "LOST" } }, state.latestEventSequence())
        return { to: "LOST", reason: "execd restarted before cgroup creation" }
      }
      case "RUNNING": {
        // L2-A：有执行句柄 → cgroup 探活接管；无句柄 → LOST（v1 语义）。
        const handles = state.listHandlesByCell(cell.cellId)
        if (handles.length === 0) {
          state.withTransaction(() => {
            state.transition(cell.cellId, attemptId, "LOST", { from: "RUNNING", reasonCode: "execd-restart-no-handle", actor: "recovery", at })
          })
          this.opts.publish({ kind: "recovery", cellId: cell.cellId, runId: cell.runId, payload: { from: "RUNNING", to: "LOST" } }, state.latestEventSequence())
          return { to: "LOST", reason: "RUNNING without execution handle (untracked)" }
        }
        const handle = handles[0]!
        const takeover = determineTakeover({
          handleId: handle.handleId,
          cellId: cell.cellId,
          runId: cell.runId,
          attemptId,
          cgroupPath: handle.cgroupPath,
          startedAt: handle.startedAt,
        }, this.probeFs)
        // 句柄记录接管结果（幂等：重复扫描更新同一行）。
        state.upsertExecutionHandle({
          handleId: handle.handleId, cellId: cell.cellId, runId: cell.runId, attemptId,
          cgroupPath: handle.cgroupPath, startedAt: handle.startedAt, takeover: takeover.state,
        })
        switch (takeover.state) {
          case "RECOVERED": {
            // 进程树仍活着：保持 RUNNING（重新接管监控）。
            state.withTransaction(() => {
              state.transition(cell.cellId, attemptId, "RUNNING", { from: "RUNNING", reasonCode: "execd-restart-takeover", actor: "recovery", at })
            })
            // IC06（P0-7）：RECOVERED live cell 记账 —— 无 capacity claim →
            // 保守 QUARANTINED charge（admission 前完成；RECOVERED_LIVE_CELL_
            // UNACCOUNTED=0）。有 claim → adopt/保持（chargeRecoveredCell 幂等）。
            let capacityState: string | undefined
            if (this.opts.capacity) {
              const charge = this.opts.capacity.chargeRecoveredCell({
                runId: cell.runId,
                cellId: cell.cellId,
                agentId: cell.agentId ?? undefined,
                cgroupPath: handle.cgroupPath,
              })
              capacityState = charge.state
            }
            this.opts.publish({ kind: "recovery", cellId: cell.cellId, runId: cell.runId, payload: { from: "RUNNING", to: "RUNNING", takeover: "RECOVERED", capacity: capacityState } }, state.latestEventSequence())
            return { to: "RUNNING", reason: `recovered via cgroup: ${handle.cgroupPath}` }
          }
          case "EXITED": {
            state.withTransaction(() => {
              state.transition(cell.cellId, attemptId, "EXIT_OBSERVED", { from: "RUNNING", reasonCode: "cgroup-empty-after-restart", actor: "recovery", at })
            })
            this.opts.publish({ kind: "recovery", cellId: cell.cellId, runId: cell.runId, payload: { from: "RUNNING", to: "EXIT_OBSERVED" } }, state.latestEventSequence())
            return { to: "EXIT_OBSERVED", reason: "cgroup empty (process tree exited during restart)" }
          }
          case "ABSENT": {
            state.withTransaction(() => {
              state.transition(cell.cellId, attemptId, "START_FAILED", { from: "RUNNING", reasonCode: "cgroup-absent-after-restart", actor: "recovery", at })
            })
            this.opts.publish({ kind: "recovery", cellId: cell.cellId, runId: cell.runId, payload: { from: "RUNNING", to: "START_FAILED" } }, state.latestEventSequence())
            return { to: "START_FAILED", reason: "cgroup absent (never started or already cleaned)" }
          }
          case "UNKNOWN": {
            // M1：cgroup 存在但 events 读不了（并发删除/权限）→ 保持
            // RUNNING 待重试（不谎报终态 —— 进程树可能仍活着）。
            state.withTransaction(() => {
              state.transition(cell.cellId, attemptId, "RUNNING", { from: "RUNNING", reasonCode: "cgroup-events-unreadable-retry", actor: "recovery", at })
            })
            this.opts.publish({ kind: "recovery", cellId: cell.cellId, runId: cell.runId, payload: { from: "RUNNING", to: "RUNNING", takeover: "UNKNOWN" } }, state.latestEventSequence())
            return { to: "RUNNING", reason: "cgroup exists but events unreadable; keep RUNNING for retry" }
          }
        }
      }
      case "EXIT_OBSERVED": {
        // 无 Receipt → Recovery Receipt（unobserved 收据：只记录已知事实）。
        // N2：receiptDigest 用 cellId+attemptId 幂等键 —— 反复重启不重复写。
        const receiptDigest = `recovery-${cell.cellId}-${attemptId}`
        state.withTransaction(() => {
          state.commitReceipt({
            receiptDigest,
            cellId: cell.cellId,
            runId: cell.runId,
            receiptJson: JSON.stringify({
              schemaVersion: "1.0",
              backend: "recovery",
              cellId: cell.cellId,
              runId: cell.runId,
              exitCode: null,
              signal: "unknown",
              timedOut: false,
              cancelled: false,
              metrics: { status: "unknown", reason: "execd restarted before receipt" },
              cleanup: { processesRemaining: -1, mountsReleased: false, cgroupRemoved: false, worktreeRetained: false, cleanupVerified: false },
              at,
            }),
            committedAt: at,
          })
          state.transition(cell.cellId, attemptId, "RECEIPT_COMMITTED", { from: "EXIT_OBSERVED", reasonCode: "recovery-receipt", actor: "recovery", at })
        })
        this.opts.publish({ kind: "recovery", cellId: cell.cellId, runId: cell.runId, payload: { from: "EXIT_OBSERVED", to: "RECEIPT_COMMITTED" } }, state.latestEventSequence())
        return { to: "RECEIPT_COMMITTED", reason: "recovery receipt committed" }
      }
      case "RECEIPT_COMMITTED": {
        // 无 Evidence 绑定 → 广播（通知上层重绑定）。
        this.opts.publish({ kind: "recovery", cellId: cell.cellId, runId: cell.runId, payload: { from: "RECEIPT_COMMITTED", action: "rebind-evidence" } }, state.latestEventSequence())
        return { to: "RECEIPT_COMMITTED", reason: "evidence rebind requested" }
      }
      case "CLEANUP_PENDING": {
        // 幂等继续清理（v1 无运行中资源）。
        state.withTransaction(() => {
          state.transition(cell.cellId, attemptId, "CLEANED", { from: "CLEANUP_PENDING", reasonCode: "cleanup-resumed", actor: "recovery", at })
        })
        return { to: "CLEANED", reason: "cleanup resumed" }
      }
      // SIDE_EFFECT_UNKNOWN 是终态（等待 reconcile）—— 不出现在恢复扫描
      // （见 TERMINAL_CELL_STATES）；外部副作用不盲跑（UNKNOWN_SIDE_EFFECT
      // _BLIND_RETRY = 0）：reconcile 是人工/外部流程，恢复不触碰。
      default:
        return { to: cell.currentState, reason: `no recovery action for ${cell.currentState}` }
    }
  }
}
