/**
 * AK2-R6 —— kernel-owned durable intent reservation。
 *
 * R6-02：把 per-coordinator 内存 Set 替换为 SQLite unique-key 持久化
 * reservation：
 * - 跨 adapter 实例 / 跨 coordinator / 跨进程 / 重启后仍保留；
 * - reserve 在调用任意 executor/broker 前发生（coordinator.execute 唯一
 *   调用点）；同一 intent 永远不能产生第二个 execution cell；
 * - crash 后 RESERVED/DISPATCHED 不得自动重新执行（reserve 对任何既有
 *   状态行都返回 false —— 包括 UNKNOWN：UNKNOWN 只能 reconcile 或人工
 *   处理，不自动恢复执行）；
 * - 状态机：RESERVED → DISPATCHED → RECEIPT_BOUND → COMMITTED/REJECTED；
 *   RESERVED → REJECTED 直接可达；非法转移抛错（fail-closed）。
 *
 * 这仍是 AK-2 execution provenance（一个 intent = 一个 cell），不实现
 * AK-4 Effect Kernel。
 */

import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { Database, type SQLQueryBindings } from "bun:sqlite"
import { ProjectionError } from "./contracts"

type RunResult = { changes: number; lastInsertRowid: number | bigint }
type RunFn = (sql: string, ...bindings: SQLQueryBindings[]) => RunResult

export type IntentReservationStatus =
  | "RESERVED"
  | "DISPATCHED"
  | "RECEIPT_BOUND"
  | "COMMITTED"
  | "REJECTED"
  | "UNKNOWN"

export interface IntentReservationRecord {
  readonly intentId: string
  readonly worldId: string
  readonly branchId: string
  readonly snapshotId: string
  readonly projectionId: string
  readonly sessionNonce: string
  readonly status: IntentReservationStatus
  readonly cellId?: string
  readonly cellSpecDigest?: string
  readonly receiptDigest?: string
  readonly commitId?: string
  readonly createdAt: number
  readonly updatedAt: number
}

export interface IntentReservationInput {
  readonly intentId: string
  readonly worldId: string
  readonly branchId: string
  readonly snapshotId: string
  readonly projectionId: string
  readonly sessionNonce: string
}

/** 默认持久化位置：所有 coordinator / 进程共享（同主机）。 */
export function defaultIntentReservationPath(): string {
  return join(require("node:os").tmpdir(), "orcana-ak2", "intent-reservations.sqlite")
}

const RESERVATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS intent_reservations (
  intent_id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  projection_id TEXT NOT NULL,
  session_nonce TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('RESERVED','DISPATCHED','RECEIPT_BOUND','COMMITTED','REJECTED','UNKNOWN')),
  cell_id TEXT,
  cell_spec_digest TEXT,
  receipt_digest TEXT,
  commit_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intent_reservations_status
  ON intent_reservations(status, updated_at);
`

/** 允许的状态转移（唯一真源；非法转移抛 EXECUTION_RECEIPT_BINDING_MISMATCH）。 */
const ALLOWED_TRANSITIONS: Readonly<Record<IntentReservationStatus, readonly IntentReservationStatus[]>> = {
  RESERVED: Object.freeze(["DISPATCHED", "REJECTED"] as readonly IntentReservationStatus[]),
  DISPATCHED: Object.freeze(["RECEIPT_BOUND", "REJECTED"] as readonly IntentReservationStatus[]),
  RECEIPT_BOUND: Object.freeze(["COMMITTED", "REJECTED"] as readonly IntentReservationStatus[]),
  COMMITTED: Object.freeze([] as readonly IntentReservationStatus[]),
  REJECTED: Object.freeze([] as readonly IntentReservationStatus[]),
  UNKNOWN: Object.freeze([] as readonly IntentReservationStatus[]),
}

export class DurableIntentReservation {
  private readonly db: Database
  private closed = false

  constructor(path?: string) {
    const resolved = path ?? defaultIntentReservationPath()
    mkdirSync(dirname(resolved), { recursive: true, mode: 0o700 })
    this.db = new Database(resolved)
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA busy_timeout = 10000")
    this.db.exec(RESERVATION_SCHEMA)
  }

  /**
   * 原子保留（SQLite UNIQUE 主键 + INSERT OR IGNORE —— 跨进程安全）。
   * 任何既有状态行（含 UNKNOWN）→ false：crash 后 / 重建后绝不重放。
   */
  reserve(input: IntentReservationInput, now = Date.now()): boolean {
    if (this.closed) throw new ProjectionError("EXECUTION_RECEIPT_BINDING_MISMATCH", "intent reservation store is closed")
    const result = (this.db.run as unknown as RunFn)(
      `INSERT OR IGNORE INTO intent_reservations (
         intent_id, world_id, branch_id, snapshot_id, projection_id, session_nonce,
         status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'RESERVED', ?, ?)`,
      input.intentId,
      input.worldId,
      input.branchId,
      input.snapshotId,
      input.projectionId,
      input.sessionNonce,
      now,
      now,
    )
    return result.changes === 1
  }

  isReserved(intentId: string): boolean {
    return this.statusOf(intentId) !== undefined
  }

  statusOf(intentId: string): IntentReservationRecord | undefined {
    const row = this.db
      .query(
        `SELECT intent_id AS intentId, world_id AS worldId, branch_id AS branchId,
                snapshot_id AS snapshotId, projection_id AS projectionId,
                session_nonce AS sessionNonce, status, cell_id AS cellId,
                cell_spec_digest AS cellSpecDigest, receipt_digest AS receiptDigest,
                commit_id AS commitId, created_at AS createdAt, updated_at AS updatedAt
         FROM intent_reservations WHERE intent_id = ?`,
      )
      .get(intentId) as Record<string, unknown> | undefined
    if (row === undefined) return undefined
    return {
      intentId: row.intentId as string,
      worldId: row.worldId as string,
      branchId: row.branchId as string,
      snapshotId: row.snapshotId as string,
      projectionId: row.projectionId as string,
      sessionNonce: row.sessionNonce as string,
      status: row.status as IntentReservationStatus,
      ...(row.cellId === null || row.cellId === undefined ? {} : { cellId: row.cellId as string }),
      ...(row.cellSpecDigest === null || row.cellSpecDigest === undefined ? {} : { cellSpecDigest: row.cellSpecDigest as string }),
      ...(row.receiptDigest === null || row.receiptDigest === undefined ? {} : { receiptDigest: row.receiptDigest as string }),
      ...(row.commitId === null || row.commitId === undefined ? {} : { commitId: row.commitId as string }),
      createdAt: row.createdAt as number,
      updatedAt: row.updatedAt as number,
    }
  }

  private transition(intentId: string, to: IntentReservationStatus, fields: Record<string, string>, now = Date.now()): void {
    const current = this.statusOf(intentId)
    if (current === undefined) {
      throw new ProjectionError("EXECUTION_RECEIPT_BINDING_MISMATCH", `intent ${intentId} is not reserved`)
    }
    if (!ALLOWED_TRANSITIONS[current.status].includes(to)) {
      throw new ProjectionError(
        "EXECUTION_RECEIPT_BINDING_MISMATCH",
        `intent ${intentId} status transition ${current.status} -> ${to} is not allowed (one-time reservation)`,
      )
    }
    const setClause = ["status = ?", "updated_at = ?", ...Object.keys(fields).map(key => `${key} = ?`)].join(", ")
    ;(this.db.run as unknown as RunFn)(
      `UPDATE intent_reservations SET ${setClause} WHERE intent_id = ?`,
      to,
      now,
      ...Object.values(fields),
      intentId,
    )
  }

  markDispatched(intentId: string, cellId?: string): void {
    this.transition(intentId, "DISPATCHED", cellId === undefined ? {} : { cell_id: cellId })
  }

  markReceiptBound(intentId: string, receiptDigest: string, cellSpecDigest?: string): void {
    this.transition(intentId, "RECEIPT_BOUND", {
      ...(receiptDigest.length === 0 ? {} : { receipt_digest: receiptDigest }),
      ...(cellSpecDigest === undefined ? {} : { cell_spec_digest: cellSpecDigest }),
    })
  }

  markCommitted(intentId: string, commitId: string): void {
    this.transition(intentId, "COMMITTED", { commit_id: commitId })
  }

  markRejected(intentId: string): void {
    this.transition(intentId, "REJECTED", {})
  }

  /** 只允许 reconcile 或人工处理：RESERVED/DISPATCHED 超龄 → UNKNOWN
   *  （不自动重新执行）。返回受影响 intentId。 */
  reconcileStale(maxAgeMs: number, now = Date.now()): string[] {
    const rows = this.db
      .query("SELECT intent_id AS intentId FROM intent_reservations WHERE status IN ('RESERVED','DISPATCHED') AND updated_at < ?")
      .all(now - maxAgeMs) as Array<{ intentId: string }>
    const affected: string[] = []
    for (const row of rows) {
      this.transition(row.intentId, "UNKNOWN", {})
      affected.push(row.intentId)
    }
    return affected
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.db.close()
    } catch {
      // 已关闭
    }
  }
}
