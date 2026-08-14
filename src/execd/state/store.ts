/** LR2-1（L1-B）：StateStore —— SQLite 持久化状态权威。
 *
 *  13 表（主计划 LR2-1 §5）：runs / domains / cells / cell_attempts /
 *  cell_events / reservations / leases / receipts / cleanup_actions /
 *  service_cells / port_leases / cache_locks / idempotency_keys。
 *
 *  关键模式：
 *  - append-only cell_events + materialized cells.current_state（物化视图）；
 *  - 状态迁移、Reservation、idempotency response 在同一个数据库事务内提交；
 *  - WAL 模式 + busy_timeout（崩溃安全：已提交事务不丢，kill 后 reopen 一致）。
 *
 *  大对象（stdout/artifact）不入库：SQLite 存索引，Filesystem/CAS 存内容。
 */

/** bun:sqlite 仅在 Bun 运行时可用。Node.js 下动态导入失败 →
 *  DatabaseCtor=null → StateStore 构造时 fail-closed 抛 SQLITE_UNAVAILABLE
 *  （持久化状态权威不能静默 no-op：状态/Receipt/幂等记录丢失等于审计
 *  丢失）。与 src/session/sqlite-session.ts 的 top-level try/catch
 *  降级模式一致；模块本身在 Node 下可正常加载。 */
type SqlValue = string | number | null | bigint | Uint8Array | boolean
interface SqliteDatabase {
  exec: (sql: string) => void
  run: (sql: string, ...params: SqlValue[]) => { changes?: number | bigint; lastInsertRowid?: number | bigint }
  /** bun:sqlite 的 query 支持双泛型（Row/Params）；这里保留签名以便
   *  调用点（含测试）不改变写法。 */
  query: <Row = unknown, Params extends unknown[] = SqlValue[]>(sql: string) => {
    get: (...params: Params) => Row | null
    all: (...params: Params) => Row[]
    run: (...params: Params) => { changes?: number | bigint; lastInsertRowid?: number | bigint }
  }
  /** bun:sqlite 的 transaction(fn) 返回可调用包装（须再次调用执行）。 */
  transaction: <T>(fn: () => T) => () => T
  close: () => void
}
let DatabaseCtor: (new (path: string) => SqliteDatabase) | null = null
try {
  DatabaseCtor = (await import("bun:sqlite")).Database as unknown as new (path: string) => SqliteDatabase
} catch {
  // Node.js runtime: bun:sqlite unavailable — StateStore constructor fails closed.
}

/** @types/bun 的 bindings 签名是数组风格且 query 必须双泛型 —— 这里
 *  收敛为宽松类型 helper，调用点保持变参风格（bun 运行时接受变参）。 */
type RunResult = { changes: number; lastInsertRowid: number | bigint }
type RunFn = (sql: string, ...bindings: SqlValue[]) => RunResult
type QueryFn = (sql: string) => {
  get: (...bindings: SqlValue[]) => unknown
  all: (...bindings: SqlValue[]) => unknown[]
}

export type CellState =
  | "ACCEPTED"
  | "POLICY_COMPILED"
  | "WAITING_RESOURCES"
  | "RESERVED"
  | "CGROUP_READY"
  | "WORKSPACE_READY"
  | "BACKEND_READY"
  | "STARTING"
  | "RUNNING"
  | "EXIT_OBSERVED"
  | "RECEIPT_COMMITTED"
  | "EVIDENCE_BOUND"
  | "CLEANUP_PENDING"
  | "CLEANED"
  // 异常终态
  | "REJECTED_POLICY"
  | "START_FAILED"
  | "CANCELLED"
  | "TIMED_OUT"
  | "OOM_KILLED"
  | "OUTPUT_LIMITED"
  | "LOST"
  | "SIDE_EFFECT_UNKNOWN"
  | "CLEANUP_FAILED"

export const TERMINAL_CELL_STATES: ReadonlySet<CellState> = new Set<CellState>([
  "CLEANED", "REJECTED_POLICY", "START_FAILED", "CANCELLED", "TIMED_OUT",
  "OOM_KILLED", "OUTPUT_LIMITED", "LOST", "SIDE_EFFECT_UNKNOWN", "CLEANUP_FAILED",
])

export interface CellEventRow {
  eventSequence: number
  cellId: string
  attemptId: string
  fromState: CellState | null
  toState: CellState
  reasonCode: string
  actor: string
  payloadDigest: string
  at: number
  kind?: "state" | "stdout" | "stderr" | "exit" | "receipt"
  payload?: string
}

export interface CellRecord {
  cellId: string
  runId: string
  nodeRunId: string
  attempt: number
  agentId?: string
  capabilityId: string
  executable: string
  argsJson: string
  cwdRef?: string
  timeoutMs?: number
  currentState: CellState
  createdAt: number
  updatedAt: number
}

export interface IdempotencyRecord {
  key: string
  method: string
  responseJson: string
  at: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  cleaned_at INTEGER
);
CREATE TABLE IF NOT EXISTS domains (
  domain_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  agent_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cells (
  cell_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_run_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  agent_id TEXT,
  capability_id TEXT NOT NULL,
  executable TEXT NOT NULL,
  args_json TEXT NOT NULL,
  cwd_ref TEXT,
  timeout_ms INTEGER,
  current_state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cell_attempts (
  attempt_id TEXT PRIMARY KEY,
  cell_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS cell_events (
  event_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  cell_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'state',
  payload TEXT
);
CREATE TABLE IF NOT EXISTS reservations (
  reservation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  cell_id TEXT NOT NULL,
  resource_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  released_at INTEGER
);
CREATE TABLE IF NOT EXISTS leases (
  lease_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  holder TEXT NOT NULL,
  ttl_ms INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  released_at INTEGER
);
CREATE TABLE IF NOT EXISTS receipts (
  receipt_digest TEXT PRIMARY KEY,
  cell_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  committed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cleanup_actions (
  action_id TEXT PRIMARY KEY,
  cell_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ok INTEGER NOT NULL,
  detail TEXT,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS service_cells (
  service_id TEXT PRIMARY KEY,
  owner_run_id TEXT NOT NULL,
  owner_agent_id TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS port_leases (
  port INTEGER PRIMARY KEY,
  service_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cache_locks (
  lock_key TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  mode TEXT NOT NULL,
  acquired_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  idempotency_key TEXT PRIMARY KEY,
  method TEXT NOT NULL,
  response_json TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS execution_handles (
  handle_id TEXT PRIMARY KEY,
  cell_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  cgroup_path TEXT NOT NULL,
  spawn_pid INTEGER,
  started_at INTEGER NOT NULL,
  takeover TEXT
);
CREATE TABLE IF NOT EXISTS log_index (
  cell_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  length_bytes INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (cell_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_handles_cell ON execution_handles(cell_id);
CREATE INDEX IF NOT EXISTS idx_cell_events_cell ON cell_events(cell_id, event_sequence);
CREATE INDEX IF NOT EXISTS idx_cells_run ON cells(run_id);
`

export class StateStore {
  readonly db: SqliteDatabase

  constructor(path: string) {
    if (!DatabaseCtor) {
      throw new Error("SQLITE_UNAVAILABLE: StateStore requires bun:sqlite (Bun runtime); Node.js 下 execd 持久化状态不可用")
    }
    this.db = new DatabaseCtor(path)
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA busy_timeout = 5000")
    this.db.exec("PRAGMA synchronous = NORMAL")
    this.db.exec(SCHEMA)
  }

  close(): void {
    this.db.close()
  }

  /** 同一数据库事务内执行（状态迁移 + Reservation + idempotency 同事务）。 */
  withTransaction<T>(fn: () => T): T {
    const run = this.db.transaction(() => fn())
    return run()
  }

  private run(sql: string, ...bindings: SqlValue[]): RunResult {
    return (this.db.run as unknown as RunFn)(sql, ...bindings)
  }

  private get<T>(sql: string, ...bindings: SqlValue[]): T | undefined {
    // bun:sqlite 无行返回 null —— 归一化为 undefined（调用方语义）。
    const row = (this.db.query as unknown as QueryFn)(sql).get(...bindings)
    return row === null || row === undefined ? undefined : (row as T)
  }

  private all<T>(sql: string, ...bindings: SqlValue[]): T[] {
    return (this.db.query as unknown as QueryFn)(sql).all(...bindings) as T[]
  }

  // ── cells ──

  upsertCell(cell: CellRecord): void {
    this.run(
      `INSERT INTO cells (cell_id, run_id, node_run_id, attempt, agent_id, capability_id, executable, args_json, cwd_ref, timeout_ms, current_state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(cell_id) DO UPDATE SET current_state = excluded.current_state, updated_at = excluded.updated_at`,
      cell.cellId, cell.runId, cell.nodeRunId, cell.attempt, cell.agentId ?? null,
      cell.capabilityId, cell.executable, cell.argsJson, cell.cwdRef ?? null, cell.timeoutMs ?? null,
      cell.currentState, cell.createdAt, cell.updatedAt,
    )
  }

  private static readonly CELL_COLUMNS = `
    cell_id AS cellId, run_id AS runId, node_run_id AS nodeRunId, attempt,
    agent_id AS agentId, capability_id AS capabilityId, executable,
    args_json AS argsJson, cwd_ref AS cwdRef, timeout_ms AS timeoutMs,
    current_state AS currentState, created_at AS createdAt, updated_at AS updatedAt`

  getCell(cellId: string): CellRecord | undefined {
    return this.get<CellRecord>(`SELECT ${StateStore.CELL_COLUMNS} FROM cells WHERE cell_id = ?`, cellId)
  }

  listCellsByRun(runId: string): CellRecord[] {
    return this.all<CellRecord>(`SELECT ${StateStore.CELL_COLUMNS} FROM cells WHERE run_id = ? ORDER BY created_at`, runId)
  }

  listNonTerminalCells(): CellRecord[] {
    const placeholders = [...TERMINAL_CELL_STATES].map(() => "?").join(",")
    return this.all<CellRecord>(
      `SELECT ${StateStore.CELL_COLUMNS} FROM cells WHERE current_state NOT IN (${placeholders}) ORDER BY created_at`,
      ...TERMINAL_CELL_STATES,
    )
  }

  setCellState(cellId: string, state: CellState, updatedAt: number): void {
    this.run("UPDATE cells SET current_state = ?, updated_at = ? WHERE cell_id = ?", state, updatedAt, cellId)
  }

  // ── cell_events（append-only）──

  appendCellEvent(ev: Omit<CellEventRow, "eventSequence">): number {
    const result = this.run(
      `INSERT INTO cell_events (cell_id, attempt_id, from_state, to_state, reason_code, actor, payload_digest, at, kind, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ev.cellId, ev.attemptId, ev.fromState ?? null, ev.toState, ev.reasonCode, ev.actor, ev.payloadDigest, ev.at,
      ev.kind ?? "state", ev.payload ?? null,
    )
    return Number(result.lastInsertRowid)
  }

  /** 非状态事件落库（stdout/stderr/exit/receipt —— 全部事件统一序号空间，
   *  保证 eventSequence 单调唯一且可断点续读，M4 修复）。 */
  appendStreamEvent(ev: {
    cellId: string
    attemptId: string
    kind: "stdout" | "stderr" | "exit" | "receipt"
    payload: string
    at?: number
  }): number {
    return this.appendCellEvent({
      cellId: ev.cellId,
      attemptId: ev.attemptId,
      fromState: null,
      toState: "RUNNING" as CellState, // 流事件不迁移状态；to_state 占位（不更新物化态）
      reasonCode: ev.kind,
      actor: "execd",
      payloadDigest: "",
      kind: ev.kind,
      payload: ev.payload,
      at: ev.at ?? Date.now(),
    })
  }

  /** 状态迁移：追加事件 + 物化 current_state（调用方置于事务内）。
   *
   *  M1 修复（审核）：守卫式 —— from 必须匹配当前状态，且当前状态不得是
   *  终态（CANCELLED 之后不得再写 EXIT_OBSERVED 等成功链）。守卫拒绝时
   *  返回 null（不追加事件、不更新物化态），调用方按幂等语义忽略。
   */
  transition(cellId: string, attemptId: string, to: CellState, opts: {
    from?: CellState | null
    reasonCode?: string
    actor?: string
    payloadDigest?: string
    at?: number
  } = {}): number | null {
    const at = opts.at ?? Date.now()
    const current = this.getCell(cellId)
    if (!current) return null
    // M1 守卫：CLEANED 是最终态（不可再迁移）；其他终态只允许收尾到
    // CLEANED（如 CANCELLED→CLEANED 的清理确认），不允许复活成功链。
    if (current.currentState === "CLEANED") return null
    if (TERMINAL_CELL_STATES.has(current.currentState) && to !== "CLEANED") return null
    if (opts.from !== undefined && opts.from !== null && current.currentState !== opts.from) return null // from 不匹配
    const sequence = this.appendCellEvent({
      cellId, attemptId,
      fromState: opts.from ?? current.currentState,
      toState: to,
      reasonCode: opts.reasonCode ?? "transition",
      actor: opts.actor ?? "execd",
      payloadDigest: opts.payloadDigest ?? "",
      at,
    })
    this.setCellState(cellId, to, at)
    return sequence
  }

  eventsForCell(cellId: string, afterSequence = 0): CellEventRow[] {
    return this.all<CellEventRow>(
      `SELECT event_sequence AS eventSequence, cell_id AS cellId, attempt_id AS attemptId,
              from_state AS fromState, to_state AS toState, reason_code AS reasonCode,
              actor, payload_digest AS payloadDigest, at, kind, payload
       FROM cell_events WHERE cell_id = ? AND event_sequence > ? ORDER BY event_sequence`,
      cellId, afterSequence,
    )
  }

  /** 全局最新事件序号（重连续读基线）。 */
  latestEventSequence(): number {
    const row = this.get<{ max: number | null }>("SELECT MAX(event_sequence) AS max FROM cell_events")
    return row?.max ?? 0
  }

  // ── runs ──

  upsertRun(runId: string, status: string, createdAt: number): void {
    this.run(
      "INSERT INTO runs (run_id, status, created_at) VALUES (?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET status = excluded.status",
      runId, status, createdAt,
    )
  }

  getRun(runId: string): { runId: string; status: string } | undefined {
    return this.get<{ runId: string; status: string }>("SELECT run_id AS runId, status FROM runs WHERE run_id = ?", runId)
  }

  // ── receipts ──

  commitReceipt(receipt: { receiptDigest: string; cellId: string; runId: string; receiptJson: string; committedAt: number }): void {
    this.run(
      "INSERT OR REPLACE INTO receipts (receipt_digest, cell_id, run_id, receipt_json, committed_at) VALUES (?, ?, ?, ?, ?)",
      receipt.receiptDigest, receipt.cellId, receipt.runId, receipt.receiptJson, receipt.committedAt,
    )
  }

  receiptForCell(cellId: string): { receiptJson: string } | undefined {
    return this.get<{ receiptJson: string }>("SELECT receipt_json AS receiptJson FROM receipts WHERE cell_id = ? ORDER BY committed_at DESC LIMIT 1", cellId)
  }

  // ── leases ──

  insertLease(l: { leaseId: string; runId: string; holder: string; ttlMs: number; expiresAt: number; createdAt: number }): void {
    this.run(
      "INSERT INTO leases (lease_id, run_id, holder, ttl_ms, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      l.leaseId, l.runId, l.holder, l.ttlMs, l.expiresAt, l.createdAt,
    )
  }

  getLease(leaseId: string): { leaseId: string; runId: string; holder: string; ttlMs: number; expiresAt: number; releasedAt: number | null } | undefined {
    return this.get<{ leaseId: string; runId: string; holder: string; ttlMs: number; expiresAt: number; releasedAt: number | null }>(
      "SELECT lease_id AS leaseId, run_id AS runId, holder, ttl_ms AS ttlMs, expires_at AS expiresAt, released_at AS releasedAt FROM leases WHERE lease_id = ?",
      leaseId,
    )
  }

  updateLeaseExpiry(leaseId: string, expiresAt: number): void {
    this.run("UPDATE leases SET expires_at = ? WHERE lease_id = ?", expiresAt, leaseId)
  }

  releaseLease(leaseId: string, releasedAt: number): void {
    this.run("UPDATE leases SET released_at = ? WHERE lease_id = ?", releasedAt, leaseId)
  }

  listActiveLeases(): Array<{ leaseId: string; runId: string; expiresAt: number }> {
    return this.all<{ leaseId: string; runId: string; expiresAt: number }>(
      "SELECT lease_id AS leaseId, run_id AS runId, expires_at AS expiresAt FROM leases WHERE released_at IS NULL",
    )
  }

  // ── execution handles（L2-A）──

  upsertExecutionHandle(h: { handleId: string; cellId: string; runId: string; attemptId: string; cgroupPath: string; spawnPid?: number; startedAt: number; takeover?: string }): void {
    this.run(
      `INSERT INTO execution_handles (handle_id, cell_id, run_id, attempt_id, cgroup_path, spawn_pid, started_at, takeover)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(handle_id) DO UPDATE SET
         cgroup_path = excluded.cgroup_path,
         spawn_pid = excluded.spawn_pid,
         started_at = excluded.started_at,
         takeover = excluded.takeover`,
      h.handleId, h.cellId, h.runId, h.attemptId, h.cgroupPath, h.spawnPid ?? null, h.startedAt, h.takeover ?? null,
    )
  }

  getExecutionHandle(handleId: string): { handleId: string; cellId: string; runId: string; attemptId: string; cgroupPath: string; spawnPid: number | null; startedAt: number; takeover: string | null } | undefined {
    return this.get<{ handleId: string; cellId: string; runId: string; attemptId: string; cgroupPath: string; spawnPid: number | null; startedAt: number; takeover: string | null }>(
      `SELECT handle_id AS handleId, cell_id AS cellId, run_id AS runId, attempt_id AS attemptId,
              cgroup_path AS cgroupPath, spawn_pid AS spawnPid, started_at AS startedAt, takeover
       FROM execution_handles WHERE handle_id = ?`,
      handleId,
    )
  }

  listHandlesByCell(cellId: string): Array<{ handleId: string; cgroupPath: string; startedAt: number; takeover: string | null }> {
    return this.all<{ handleId: string; cgroupPath: string; startedAt: number; takeover: string | null }>(
      `SELECT handle_id AS handleId, cgroup_path AS cgroupPath, started_at AS startedAt, takeover
       FROM execution_handles WHERE cell_id = ? ORDER BY started_at DESC`,
      cellId,
    )
  }

  deleteExecutionHandle(handleId: string): void {
    this.run("DELETE FROM execution_handles WHERE handle_id = ?", handleId)
  }

  // ── log index（L2-B）──

  upsertLogIndex(row: { cellId: string; kind: string; lengthBytes: number; updatedAt: number }): void {
    this.run(
      `INSERT INTO log_index (cell_id, kind, length_bytes, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(cell_id, kind) DO UPDATE SET length_bytes = excluded.length_bytes, updated_at = excluded.updated_at`,
      row.cellId, row.kind, row.lengthBytes, row.updatedAt,
    )
  }

  getLogIndex(cellId: string, kind: string): { cellId: string; kind: string; lengthBytes: number; updatedAt: number } | undefined {
    return this.get<{ cellId: string; kind: string; lengthBytes: number; updatedAt: number }>(
      "SELECT cell_id AS cellId, kind, length_bytes AS lengthBytes, updated_at AS updatedAt FROM log_index WHERE cell_id = ? AND kind = ?",
      cellId, kind,
    )
  }

  deleteLogIndex(cellId: string): void {
    this.run("DELETE FROM log_index WHERE cell_id = ?", cellId)
  }

  // ── idempotency ──

  getIdempotentResponse(key: string): IdempotencyRecord | undefined {
    return this.get<IdempotencyRecord>(
      "SELECT idempotency_key AS key, method, response_json AS responseJson, at FROM idempotency_keys WHERE idempotency_key = ?",
      key,
    )
  }

  putIdempotentResponse(record: IdempotencyRecord): void {
    this.run(
      "INSERT OR REPLACE INTO idempotency_keys (idempotency_key, method, response_json, at) VALUES (?, ?, ?, ?)",
      record.key, record.method, record.responseJson, record.at,
    )
  }
}
