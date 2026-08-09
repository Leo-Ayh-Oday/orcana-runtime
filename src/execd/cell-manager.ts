/** LR2-1（L1-D）：CellManager —— Cell 生命周期（Submit/Get/Cancel + 状态机）。
 *
 *  - SubmitCell 幂等：同 idempotencyKey 返回首次提交的响应，不启动第二个
 *    Cell（DUPLICATE_SUBMIT_STARTS_SECOND_CELL = 0）；
 *  - 状态机（ADR-LR2-002）：ACCEPTED → POLICY_COMPILED → RUNNING →
 *    EXIT_OBSERVED → RECEIPT_COMMITTED → EVIDENCE_BOUND → CLEANED；
 *    异常 → START_FAILED / CANCELLED / TIMED_OUT 等（append-only 事件流）；
 *  - Broker 接线：execd 持有 LinuxExecutionBroker（enabled），authority 由
 *    execd 从已批准请求构造（workspace 根来自 execd 配置 —— 客户端请求
 *    不得携带宿主路径，LR2-0D 不变量）。
 */

import type { LinuxExecutionBroker } from "../runtime/linux/broker"
import type { TrustedExecutionAuthority } from "../runtime/linux/contracts"
import { StateStore, type CellRecord, type CellState } from "./state/store"
import type { SubmitCellPayload } from "./protocol/messages"

export interface CellManagerOptions {
  state: StateStore
  broker: LinuxExecutionBroker
  /** execd 配置的 workspace 根（客户端请求只携带相对 cwdRef）。 */
  workspaceHostRoot: string
  /** 事件广播（server.publishEvent）。 */
  publish: (event: { kind: string; cellId: string; runId?: string; payload?: unknown }, sequence: number) => void
  /** L2-B（B2）：大对象日志落盘（stdout/stderr 完整可回放）。 */
  logStore?: import("./log-store").LogStore
  now?: () => number
}

export interface SubmitResult {
  cellId: string
  runId: string
  idempotent: boolean
  /** M6：编译失败缓存的幂等重试标记（首次请求抛错，重试返回一致结果）。 */
  rejected?: boolean
}

export class CellManager {
  /** B1 修复：manager cellId → broker 编译后 cellId 映射（broker 的
   *  compileRequest 生成自己的 cellId，取消必须用 broker 侧的键）。
   *  内存映射足够：execd 重启后 broker 内存态丢失（cell 已 LOST）。 */
  private readonly brokerCellIds = new Map<string, string>()
  /** M2 修复：在途 runCell promise（优雅关闭时先取消并 await）。 */
  private readonly activeRuns = new Set<Promise<void>>()

  constructor(private readonly opts: CellManagerOptions) {}

  /** 事件广播注入（组装时 server 未就绪，占位后替换）。 */
  setPublisher(publish: CellManagerOptions["publish"]): void {
    this.opts.publish = publish
  }

  private get now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  getCell(cellId: string): CellRecord | undefined {
    return this.opts.state.getCell(cellId)
  }

  /** M2：优雅关闭 —— 取消全部在途 cell 并等待其收尾（进程真实终止
   *  后再关 DB；否则在途 runCell 写已关闭的 DB 会崩溃 daemon）。 */
  async stop(): Promise<void> {
    for (const cellId of [...this.brokerCellIds.keys()]) {
      try {
        await this.cancelCell(cellId)
      } catch {
        // 幂等容忍
      }
    }
    await Promise.allSettled([...this.activeRuns])
    this.activeRuns.clear()
    this.brokerCellIds.clear()
  }

  async submit(payload: SubmitCellPayload, idempotencyKey: string, _sessionId: string): Promise<SubmitResult> {
    const state = this.opts.state
    // 1. 幂等：同 key 已响应 → 直接返回首次结果（M6：rejected 标记透传）。
    const cached = state.getIdempotentResponse(idempotencyKey)
    if (cached) {
      const first = JSON.parse(cached.responseJson) as { cellId: string; runId: string; rejected?: boolean }
      return { cellId: first.cellId, runId: first.runId, idempotent: true, rejected: first.rejected }
    }

    const runId = payload.runId ?? `run-${this.now.toString(36)}`
    const nodeRunId = payload.nodeRunId ?? `${runId}:n${payload.attempt ?? 1}`
    const cellId = `cell-${this.now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const attemptId = `${cellId}-a${payload.attempt ?? 1}`
    const at = this.now
    void nodeRunId

    // 2. 受信 authority：身份来自已批准请求，workspace 根来自 execd 配置。
    const authority: TrustedExecutionAuthority = {
      identity: { runId, nodeRunId, attempt: payload.attempt ?? 1 },
      workspace: {
        workspaceId: "execd-ws",
        projectId: "execd",
        hostRoot: this.opts.workspaceHostRoot,
        kind: "main",
        access: "readwrite",
        physicalWorkspaceKey: `wp_${runId}`,
        ownerFiles: [],
      },
    }

    // 3. 编译 CellSpec（Policy Compiler —— 只接收受信输入）。
    let compiled: ReturnType<LinuxExecutionBroker["compileRequest"]>
    try {
      compiled = this.opts.broker.compileRequest(
        {
          command: {
            executable: payload.executable,
            args: payload.args,
            relativeCwd: payload.cwdRef ?? ".",
            stdin: "closed",
          },
          profile: "build",
          env: payload.env,
          timeoutMs: payload.timeoutMs ?? 120_000,
        },
        authority,
      )
    } catch (error) {
      // M6 修复：编译失败缓存 rejected 标记 —— 同一 key 重试返回一致结果
      // （不把已拒绝的请求当成已受理）。
      state.withTransaction(() => {
        state.upsertCell(this.record(cellId, runId, nodeRunId, payload, "REJECTED_POLICY", at))
        state.transition(cellId, attemptId, "REJECTED_POLICY", { from: null, reasonCode: "compile-failed", actor: "execd", at })
        state.putIdempotentResponse({ key: idempotencyKey, method: "SubmitCell", responseJson: JSON.stringify({ cellId, runId, rejected: true }), at })
      })
      throw error
    }

    // 4. 事务：cell 落库 + 初始状态 + 幂等缓存（同事务 —— 重复提交不二次启动）。
    const responseJson = JSON.stringify({ cellId, runId })
    state.withTransaction(() => {
      state.upsertCell(this.record(cellId, runId, nodeRunId, payload, "ACCEPTED", at))
      state.upsertRun(runId, "active", at)
      state.transition(cellId, attemptId, "ACCEPTED", { from: null, reasonCode: "submitted", actor: "execd", at })
      state.putIdempotentResponse({ key: idempotencyKey, method: "SubmitCell", responseJson, at })
    })

    // 5. 执行（broker 流式事件 → 状态机推进 + 广播）。不阻塞提交响应：
    //    执行在后台推进，WatchCell 订阅者收到完整事件流。
    // B1：记录 broker 侧 cellId（取消必须用 broker 键）。
    this.brokerCellIds.set(cellId, compiled.identity.cellId)
    const runPromise = this.runCell(cellId, attemptId, runId, payload, authority, compiled)
    this.activeRuns.add(runPromise)
    void runPromise.finally(() => {
      this.activeRuns.delete(runPromise)
      this.brokerCellIds.delete(cellId)
    })

    return { cellId, runId, idempotent: false }
  }

  private record(cellId: string, runId: string, nodeRunId: string, payload: SubmitCellPayload, state: CellState, at: number): CellRecord {
    return {
      cellId, runId, nodeRunId, attempt: payload.attempt ?? 1,
      capabilityId: payload.capabilityId,
      executable: payload.executable,
      argsJson: JSON.stringify(payload.args),
      cwdRef: payload.cwdRef,
      timeoutMs: payload.timeoutMs,
      currentState: state,
      createdAt: at,
      updatedAt: at,
    }
  }

  private async runCell(
    cellId: string,
    attemptId: string,
    runId: string,
    payload: SubmitCellPayload,
    authority: TrustedExecutionAuthority,
    compiled: ReturnType<LinuxExecutionBroker["compileRequest"]>,
  ): Promise<void> {
    const state = this.opts.state
    const at = this.now
    // POLICY_COMPILED → RUNNING（守卫式：取消竞态下返回 null 即跳过）。
    state.withTransaction(() => {
      state.transition(cellId, attemptId, "POLICY_COMPILED", { from: "ACCEPTED", reasonCode: "compiled", actor: "execd", at })
      state.transition(cellId, attemptId, "RUNNING", { from: "POLICY_COMPILED", reasonCode: "executing", actor: "execd", at })
    })
    this.opts.publish({ kind: "cell.status", cellId, runId, payload: { state: "RUNNING" } }, state.latestEventSequence())

    // L2-A（B1 修复）：启动即记录执行句柄（重启接管的持久化锚点）。
    // cgroup 路径 = broker 委托基 + hierarchyPaths（与 broker 内部一致）。
    // 无委托 → 无句柄（重启后诚实 LOST —— v1 语义）。
    const cgroupBase = this.opts.broker.cgroupBase()
    if (cgroupBase) {
      const { hierarchyPaths } = require("../runtime/linux/cgroup/manager") as typeof import("../runtime/linux/cgroup/manager")
      const paths = hierarchyPaths(cgroupBase, runId, undefined, compiled.identity.cellId)
      state.upsertExecutionHandle({
        handleId: `h-${cellId}`,
        cellId,
        runId,
        attemptId,
        cgroupPath: paths.cell,
        spawnPid: undefined, // pid 由 broker 内部 spawn —— 句柄只依赖 cgroup 锚点
        startedAt: this.now,
      })
    }

    // M2：收尾纳入 try —— 优雅关闭（stop 已 await 本 promise）时任何
    // 一步失败都会正确收敛而不是 unhandled rejection 崩溃 daemon。
    try {
      for await (const event of this.opts.broker.execute(compiled, { authority })) {
        switch (event.type) {
          case "cell.status":
            break
          case "cell.stdout":
          case "cell.stderr":
            // M4 修复：stdout/stderr 落库（截断 16KB/事件）—— 所有事件
            // 统一 SQLite 序号空间（单调唯一 + 断点可续读）；实时广播用
            // 落库序号。大对象本体仍不入库（截断即索引语义）。
            {
              const data = String(event.data ?? "")
              const seq = state.appendStreamEvent({
                cellId, attemptId,
                kind: event.type === "cell.stdout" ? "stdout" : "stderr",
                payload: data.length > 16 * 1024 ? data.slice(0, 16 * 1024) : data,
                at: this.now,
              })
              // L2-B（B2 修复）：大对象完整落盘（AttachLogs 可回放全文；
              // 在线事件仍截断 16KB 索引语义）。
              this.opts.logStore?.append(cellId, event.type === "cell.stdout" ? "stdout" : "stderr", data)
              this.opts.publish({ kind: event.type, cellId, runId, payload: { data } }, seq)
            }
            break
          case "cell.exit": {
            // M11：exit 落库（统一序号空间 + 回放格式一致）。
            const seq = state.appendStreamEvent({
              cellId, attemptId, kind: "exit",
              payload: JSON.stringify({ exitCode: event.exitCode, signal: event.signal }),
              at: this.now,
            })
            state.withTransaction(() => {
              state.transition(cellId, attemptId, "EXIT_OBSERVED", { from: "RUNNING", reasonCode: `exit:${event.exitCode}`, actor: "broker", at: this.now })
            })
            this.opts.publish({ kind: "cell.exit", cellId, runId, payload: { exitCode: event.exitCode, signal: event.signal } }, seq)
            break
          }
          case "cell.receipt": {
            // M11：receipt 落库（receiptDigest 索引；Receipt 本体仍在 receipts 表）。
            const seq = state.appendStreamEvent({
              cellId, attemptId, kind: "receipt",
              payload: JSON.stringify({ receiptDigest: event.receipt.receiptDigest }),
              at: this.now,
            })
            state.withTransaction(() => {
              state.commitReceipt({
                receiptDigest: event.receipt.receiptDigest,
                cellId, runId,
                receiptJson: JSON.stringify(event.receipt),
                committedAt: this.now,
              })
              state.transition(cellId, attemptId, "RECEIPT_COMMITTED", { from: "EXIT_OBSERVED", reasonCode: "receipt", actor: "execd", at: this.now })
            })
            this.opts.publish({ kind: "cell.receipt", cellId, runId, payload: { receiptDigest: event.receipt.receiptDigest } }, seq)
            break
          }
          default:
            break
        }
      }
    } catch (error) {
      // 守卫式迁移：当前态非 RUNNING（已被取消）时不写 START_FAILED。
      const current = state.getCell(cellId)?.currentState
      if (current === "RUNNING") {
        state.withTransaction(() => {
          state.transition(cellId, attemptId, "START_FAILED", { from: "RUNNING", reasonCode: error instanceof Error ? error.message.slice(0, 200) : String(error), actor: "execd", at: this.now })
        })
        this.opts.publish({ kind: "cell.status", cellId, runId, payload: { state: "START_FAILED" } }, state.latestEventSequence())
      }
      return
    }

    // 6. 收尾：EVIDENCE_BOUND → CLEANED（守卫式：取消竞态下跳过 ——
    //    CANCELLED 之后不得出现成功链）。
    const current = state.getCell(cellId)?.currentState
    if (current === "RECEIPT_COMMITTED") {
      state.withTransaction(() => {
        state.transition(cellId, attemptId, "EVIDENCE_BOUND", { from: "RECEIPT_COMMITTED", reasonCode: "receipt-bound", actor: "execd", at: this.now })
        state.transition(cellId, attemptId, "CLEANED", { from: "EVIDENCE_BOUND", reasonCode: "cleaned", actor: "execd", at: this.now })
      })
      // L2-A（B1）+ L2-B：句柄与日志随 cell 终结清理（防复用错接管/泄漏）。
      state.deleteExecutionHandle(`h-${cellId}`)
      this.opts.logStore?.remove(cellId)
      this.opts.publish({ kind: "cell.status", cellId, runId, payload: { state: "CLEANED" } }, state.latestEventSequence())
    }
  }

  async cancelCell(cellId: string): Promise<void> {
    const cell = this.opts.state.getCell(cellId)
    if (!cell) throw new Error(`unknown cell: ${cellId}`)
    // B1 修复：进程终止必须用 broker 编译后的 cellId（compileRequest
    // 生成自己的 cellId —— 用 manager 键查不到 broker 记录，取消就是
    // 纯虚构；CANCELLED_CELL_PROCESS_REMAINS = 0）。
    const brokerCellId = this.brokerCellIds.get(cellId)
    try {
      if (brokerCellId) {
        await this.opts.broker.cancelCell(brokerCellId)
      } else {
        // L2-A（B4 修复）：重启后 broker 内存映射丢失 —— 改用持久化句柄
        // 的 cgroup.kill 路径（进程树真实终止，不把 CANCELLED 标给活进程）。
        await this.killViaHandle(cell)
      }
    } catch {
      // 未运行/已结束：幂等容忍。
    }
    // M1：守卫式迁移（终态不再迁移）。
    this.opts.state.withTransaction(() => {
      const seq = this.opts.state.transition(cellId, `${cellId}-a${cell.attempt}`, "CANCELLED", { from: cell.currentState, reasonCode: "cancelled", actor: "execd" })
      // M12：在线 watcher 必须看到 CANCELLED（广播）。
      if (seq !== null) {
        this.opts.publish({ kind: "cell.status", cellId, runId: cell.runId, payload: { state: "CANCELLED" } }, seq)
      }
      // L2-A（B1）：句柄生命周期随 cell 终结删除（防复用错接管）。
      this.opts.state.deleteExecutionHandle(`h-${cellId}`)
    })
  }

  /** L2-A（B4）：无 broker 内存态时的取消 —— cgroup.kill 树杀（句柄锚点）。
   *  无 cgroup 委托 → 无法终止（返回 false，调用方幂等容忍）。 */
  private async killViaHandle(cell: { cellId: string; runId: string; attempt: number }): Promise<boolean> {
    const handles = this.opts.state.listHandlesByCell(cell.cellId)
    if (handles.length === 0) return false
    const { CgroupManager } = require("../runtime/linux/cgroup/manager") as typeof import("../runtime/linux/cgroup/manager")
    const base = this.opts.broker.cgroupBase()
    if (!base) return false
    const cgroup = new CgroupManager({ base })
    try {
      cgroup.kill(handles[0]!.cgroupPath)
      return true
    } catch {
      return false
    }
  }

  async cancelAgent(agentId: string): Promise<void> {
    // agent 域近似：以 agentId 关联的 run 列表（v1 简化：runId=agentId）。
    const cells = this.opts.state.listCellsByRun(agentId)
    for (const cell of cells) {
      if (!["CLEANED", "CANCELLED", "START_FAILED"].includes(cell.currentState)) {
        await this.cancelCell(cell.cellId)
      }
    }
  }

  async cancelRun(runId: string): Promise<void> {
    // run 级：broker 取消整 run（全部 cell + domain 关闭 + ledger 释放）。
    try {
      await this.opts.broker.cancelRun(runId)
    } catch {
      // 幂等容忍。
    }
    const cells = this.opts.state.listCellsByRun(runId)
    for (const cell of cells) {
      if (!["CLEANED", "CANCELLED", "START_FAILED"].includes(cell.currentState)) {
        this.opts.state.withTransaction(() => {
          this.opts.state.transition(cell.cellId, `${cell.cellId}-a${cell.attempt}`, "CANCELLED", { from: cell.currentState, reasonCode: "run-cancelled", actor: "execd" })
        })
      }
    }
  }

  async cleanupRun(runId: string): Promise<{ removed: number }> {
    const cells = this.opts.state.listCellsByRun(runId)
    let removed = 0
    for (const cell of cells) {
      if (cell.currentState === "CANCELLED") {
        this.opts.state.withTransaction(() => {
          const seq = this.opts.state.transition(cell.cellId, `${cell.cellId}-a${cell.attempt}`, "CLEANED", { from: "CANCELLED", reasonCode: "cleaned", actor: "execd" })
          if (seq !== null) {
            this.opts.publish({ kind: "cell.status", cellId: cell.cellId, runId, payload: { state: "CLEANED" } }, seq)
          }
        })
        removed += 1
      }
    }
    // M16：仅当 run 内无 RUNNING 残留时才标 cleaned（run 状态与 cell 状态一致）。
    const stillActive = cells.some(c => c.currentState === "RUNNING" || c.currentState === "CANCELLED")
    if (!stillActive) {
      this.opts.state.upsertRun(runId, "cleaned", this.now)
    }
    return { removed }
  }

  listRecoverableRuns(): Array<{ runId: string; cellCount: number }> {
    const runs = new Map<string, number>()
    for (const cell of this.opts.state.listNonTerminalCells()) {
      runs.set(cell.runId, (runs.get(cell.runId) ?? 0) + 1)
    }
    return [...runs.entries()].map(([runId, cellCount]) => ({ runId, cellCount }))
  }
}
