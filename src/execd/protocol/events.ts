/** LR2-1（L1-A）：ServerEvent —— 事件流契约。
 *
 *  每个事件必须包含单调递增 eventSequence（SQLite cell_events 行号），
 *  TUI/客户端重连后从最后确认的序号继续读取（EVENT_SEQUENCE_GAP）。
 */

export interface ServerEvent {
  type: "event"
  eventSequence: number
  kind: string
  cellId?: string
  runId?: string
  payload?: unknown
  at: number
}

export const EVENT_KINDS = {
  CELL_STATUS: "cell.status",
  CELL_STDOUT: "cell.stdout",
  CELL_STDERR: "cell.stderr",
  CELL_EXIT: "cell.exit",
  CELL_RECEIPT: "cell.receipt",
  CELL_EVIDENCE: "cell.evidence",
  RUN_STATUS: "run.status",
  LEASE_EXPIRED: "lease.expired",
  RECOVERY: "recovery",
} as const
