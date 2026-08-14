/** LR2-1（L1-A）：RPC 消息契约 —— Request/Response 与 12 个核心方法。
 *
 *  每个请求必须包含：protocolVersion / requestId / idempotencyKey /
 *  sessionId / sequence / payload / approvalToken（LR2-1 §4）。
 *  响应：ok 携带结果；error 携带稳定错误码。
 */

export const PROTOCOL_VERSION = 1

export interface RequestBase {
  protocolVersion: number
  requestId: string
  /** 幂等键：同 idempotencyKey 的重复请求返回首次结果（不二次生效）。 */
  idempotencyKey: string
  sessionId: string
  /** 客户端单调序号（调试/重放检测）。 */
  sequence: number
  approvalToken?: string
}

export type Request =
  | ({ method: "Hello" } & RequestBase)
  | ({ method: "SubmitCell"; payload: SubmitCellPayload } & RequestBase)
  | ({ method: "WatchCell"; payload: { cellId: string; sinceSequence?: number } } & RequestBase)
  | ({ method: "GetCell"; payload: { cellId: string } } & RequestBase)
  | ({ method: "CancelCell"; payload: { cellId: string } } & RequestBase)
  | ({ method: "CancelAgent"; payload: { agentId: string } } & RequestBase)
  | ({ method: "CancelRun"; payload: { runId: string } } & RequestBase)
  | ({ method: "CleanupRun"; payload: { runId: string } } & RequestBase)
  | ({ method: "AcquireLease"; payload: { runId: string; ttlMs: number } } & RequestBase)
  | ({ method: "RenewLease"; payload: { leaseId: string; ttlMs: number } } & RequestBase)
  | ({ method: "ReleaseLease"; payload: { leaseId: string } } & RequestBase)
  | ({ method: "AttachLogs"; payload: { cellId: string; kind?: "stdout" | "stderr"; offset?: number } } & RequestBase)
  | ({ method: "ListRecoverableRuns"; payload: Record<string, never> } & RequestBase)
  | ({ method: "CapacityReserve"; payload: import("../../runtime/linux/scheduler/host-capacity").CapacityReserveRequest & { clientInstanceId: string } } & RequestBase)
  | ({ method: "CapacityReleaseRequest"; payload: { claimId: string; ownerToken: string; clientInstanceId: string } } & RequestBase)
  | ({ method: "CapacityPhase"; payload: { claimId: string; ownerToken: string; phase: string; spawn?: { pid: number; startticks: number; cgroupPath?: string }; clientInstanceId: string } } & RequestBase)
  | ({ method: "CapacityReconcile"; payload: { clientInstanceId: string } } & RequestBase)
  | ({ method: "CapacityStatus"; payload: { clientInstanceId: string } } & RequestBase)

/** SubmitCell：复用 ExecutionIntent 的业务形状（LR2-0D 契约）。 */
export interface SubmitCellPayload {
  capabilityId: string
  executable: string
  args: string[]
  cwdRef?: string
  timeoutMs?: number
  env?: Record<string, string>
  workloadKind: "inspect" | "build" | "test" | "dependency" | "service"
  readonly: boolean
  runId?: string
  nodeRunId?: string
  attempt?: number
  approvalToken?: string
}

export interface ErrorBody {
  code: string
  message: string
}

export type Response =
  | { type: "ok"; requestId: string; result: unknown }
  | { type: "error"; requestId: string; error: ErrorBody }

/** 稳定错误码（客户端据此分类处理）。 */
export const EXECD_ERROR_CODES = {
  BAD_FRAME: "EXECD_BAD_FRAME",
  BAD_REQUEST: "EXECD_BAD_REQUEST",
  PROTOCOL_VERSION_MISMATCH: "EXECD_PROTOCOL_VERSION_MISMATCH",
  UNKNOWN_METHOD: "EXECD_UNKNOWN_METHOD",
  UNAUTHENTICATED: "EXECD_UNAUTHENTICATED",
  UNAUTHORIZED_APPROVAL: "EXECD_UNAUTHORIZED_APPROVAL",
  UNKNOWN_CELL: "EXECD_UNKNOWN_CELL",
  UNKNOWN_RUN: "EXECD_UNKNOWN_RUN",
  CELL_NOT_OWNED: "EXECD_CELL_NOT_OWNED",
  LEASE_INVALID: "EXECD_LEASE_INVALID",
  LEASE_EXPIRED: "EXECD_LEASE_EXPIRED",
  SESSION_UNKNOWN: "EXECD_SESSION_UNKNOWN",
  INTERNAL: "EXECD_INTERNAL",
} as const
