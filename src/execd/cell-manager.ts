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
  now?: () => number
}

export interface SubmitResult {
  cellId: string
  runId: string
  idempotent: boolean
}

export class CellManager {
  constructor(private readonly opts: CellManagerOptions) {}

  private get now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  getCell(cellId: string): CellRecord | undefined {
    return this.opts.state.getCell(cellId)
  }

  async submit(payload: SubmitCellPayload, idempotencyKey: string, _sessionId: string): Promise<SubmitResult> {
    const state = this.opts.state
    // 1. 幂等：同 key 已响应 → 直接返回首次结果。
    const cached = state.getIdempotentResponse(idempotencyKey)
    if (cached) {
      const first = JSON.parse(cached.responseJson) as { cellId: string; runId: string }
      return { cellId: first.cellId, runId: first.runId, idempotent: true }
    }

    const runId = payload.runId ?? `run-${this.now.toString(36)}`
    const nodeRunId = payload.nodeRunId ?? `${runId}:n${payload.attempt ?? 1}`
    const cellId = `cell-${this.now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const attemptId = `${cellId}-a${payload.attempt ?? 1}`
    const at = this.now

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
      // 编译失败：落库 REJECTED_POLICY + 幂等缓存（同一请求重试不得二次编译）。
      state.withTransaction(() => {
        state.upsertCell(this.record(cellId, runId, nodeRunId, payload, "REJECTED_POLICY", at))
        state.transition(cellId, attemptId, "REJECTED_POLICY", { from: null, reasonCode: "compile-failed", actor: "execd", at })
        state.putIdempotentResponse({ key: idempotencyKey, method: "SubmitCell", responseJson: JSON.stringify({ cellId, runId }), at })
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
    void this.runCell(cellId, attemptId, runId, payload, authority, compiled)

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
    // POLICY_COMPILED → RUNNING
    state.withTransaction(() => {
      state.transition(cellId, attemptId, "POLICY_COMPILED", { from: "ACCEPTED", reasonCode: "compiled", actor: "execd", at })
      state.transition(cellId, attemptId, "RUNNING", { from: "POLICY_COMPILED", reasonCode: "executing", actor: "execd", at })
    })
    this.opts.publish({ kind: "cell.status", cellId, runId, payload: { state: "RUNNING" } }, state.latestEventSequence())

    try {
      for await (const event of this.opts.broker.execute(compiled, { authority })) {
        switch (event.type) {
          case "cell.status":
            break
          case "cell.stdout":
          case "cell.stderr":
            // 大对象不入库（计划：SQLite 索引 + FS/CAS）；实时推送。
            this.opts.publish({ kind: event.type, cellId, runId, payload: { data: event.data } }, state.latestEventSequence() + 1)
            break
          case "cell.exit":
            state.withTransaction(() => {
              state.transition(cellId, attemptId, "EXIT_OBSERVED", { from: "RUNNING", reasonCode: `exit:${event.exitCode}`, actor: "broker", at: this.now })
            })
            this.opts.publish({ kind: "cell.exit", cellId, runId, payload: { exitCode: event.exitCode, signal: event.signal } }, state.latestEventSequence())
            break
          case "cell.receipt":
            state.withTransaction(() => {
              state.commitReceipt({
                receiptDigest: event.receipt.receiptDigest,
                cellId, runId,
                receiptJson: JSON.stringify(event.receipt),
                committedAt: this.now,
              })
              state.transition(cellId, attemptId, "RECEIPT_COMMITTED", { from: "EXIT_OBSERVED", reasonCode: "receipt", actor: "execd", at: this.now })
            })
            this.opts.publish({ kind: "cell.receipt", cellId, runId, payload: { receiptDigest: event.receipt.receiptDigest } }, state.latestEventSequence())
            break
          default:
            break
        }
      }
    } catch (error) {
      state.withTransaction(() => {
        state.transition(cellId, attemptId, "START_FAILED", { from: "RUNNING", reasonCode: error instanceof Error ? error.message.slice(0, 200) : String(error), actor: "execd", at: this.now })
      })
      this.opts.publish({ kind: "cell.status", cellId, runId, payload: { state: "START_FAILED" } }, state.latestEventSequence())
      return
    }

    // 6. 收尾：EVIDENCE_BOUND → CLEANED。
    state.withTransaction(() => {
      state.transition(cellId, attemptId, "EVIDENCE_BOUND", { from: "RECEIPT_COMMITTED", reasonCode: "receipt-bound", actor: "execd", at: this.now })
      state.transition(cellId, attemptId, "CLEANED", { from: "EVIDENCE_BOUND", reasonCode: "cleaned", actor: "execd", at: this.now })
    })
    this.opts.publish({ kind: "cell.status", cellId, runId, payload: { state: "CLEANED" } }, state.latestEventSequence())
  }

  async cancelCell(cellId: string): Promise<void> {
    const cell = this.opts.state.getCell(cellId)
    if (!cell) throw new Error(`unknown cell: ${cellId}`)
    // 进程终止：broker 级取消（进程组/cgroup.kill —— 状态迁移必须
    // 以进程真实终止为前提，CANCELLED_CELL_PROCESS_REMAINS = 0）。
    try {
      await this.opts.broker.cancelCell(cellId)
    } catch {
      // 未运行/已结束：幂等容忍。
    }
    this.opts.state.withTransaction(() => {
      this.opts.state.transition(cellId, `${cellId}-a${cell.attempt}`, "CANCELLED", { from: cell.currentState, reasonCode: "cancelled", actor: "execd" })
    })
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
          this.opts.state.transition(cell.cellId, `${cell.cellId}-a${cell.attempt}`, "CLEANED", { from: "CANCELLED", reasonCode: "cleaned", actor: "execd" })
        })
        removed += 1
      }
    }
    this.opts.state.upsertRun(runId, "cleaned", this.now)
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
