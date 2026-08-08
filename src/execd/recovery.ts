/** LR2-1（L1-F）：Recovery —— 启动恢复（非终态 Attempt 扫描）。
 *
 *  恢复动作表（主计划 LR2-1 §7，v1 适配）：
 *  - ACCEPTED / POLICY_COMPILED / RUNNING：execd 崩溃 → broker 内存态
 *    丢失，进程无法接管（v1 不要求 execd 崩溃后 Cell 继续运行）→ LOST
 *    （原因如实记录：execd restarted, process untracked）；
 *  - EXIT_OBSERVED：无 Receipt → 从现存观测生成 Recovery Receipt
 *    （unobserved 收据 —— 只记录已知事实，未知字段 unknown）；
 *  - RECEIPT_COMMITTED：无 Evidence 绑定 → 广播 recovery 事件（通知
 *    上层重绑定）；
 *  - CLEANUP_PENDING：幂等继续清理（v1 无运行中资源 → 直接 CLEANED）；
 *  - SIDE_EFFECT_UNKNOWN：外部副作用节点 —— 不得盲跑；标记 + 广播，
 *    等待 reconcile（查询外部系统 → commit/retry/human intervention）。
 *
 *  同 boot 崩溃恢复：SAME_BOOT_CRASH_UNRECOVERED = 0 —— 每次启动扫描
 *  全部非终态 Attempt 并收敛（同一开机内的多次崩溃同样处理）。
 */

import { StateStore, type CellRecord, type CellState } from "./state/store"

export interface RecoveryOptions {
  state: StateStore
  /** 事件广播（server.publishEvent）。 */
  publish: (event: { kind: string; cellId: string; runId?: string; payload?: unknown }, sequence: number) => void
  now?: () => number
}

export interface RecoveryReport {
  scanned: number
  recovered: Array<{ cellId: string; from: CellState; to: CellState; reason: string }>
}

export class Recovery {
  constructor(private readonly opts: RecoveryOptions) {}

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
      case "POLICY_COMPILED":
      case "RUNNING": {
        // execd 重启 → 进程无法接管（broker 内存态丢失）。v1 如实标记
        // LOST（不假装恢复）—— 计划 §7 的"重新接管监控"依赖跨进程
        // 执行句柄，属 execd v2 范围。
        state.withTransaction(() => {
          state.transition(cell.cellId, attemptId, "LOST", { from: cell.currentState, reasonCode: "execd-restart-untracked", actor: "recovery", at })
        })
        this.opts.publish({ kind: "recovery", cellId: cell.cellId, runId: cell.runId, payload: { from: cell.currentState, to: "LOST" } }, state.latestEventSequence())
        return { to: "LOST", reason: "execd restarted, process untracked" }
      }
      case "EXIT_OBSERVED": {
        // 无 Receipt → Recovery Receipt（unobserved 收据：只记录已知事实）。
        state.withTransaction(() => {
          state.commitReceipt({
            receiptDigest: `recovery-${cell.cellId}-${at}`,
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
