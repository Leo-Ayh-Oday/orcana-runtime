/** LR2-1（L1-C）：execd Server —— Unix socket 监听 + 帧路由 + 认证。
 *
 *  - socket：$XDG_RUNTIME_DIR/orcana/execd.sock（目录 0700、socket 0600）；
 *  - 认证：SO_PEERCRED（对端 uid ≠ 本进程 uid 即拒绝）——UNAUTHENTICATED
 *    _LOCAL_CLIENT = 0；ffi 不可用时显式降级（只依赖文件权限 0600/0700）；
 *  - 路由：请求 → 方法分发（Hello/GetCell/WatchCell/…）→ 响应帧；
 *  - 事件：WatchCell 订阅后 ServerEvent 帧推送（eventSequence 单调）。
 */

import net from "node:net"
import { mkdirSync, chmodSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { FrameCodec, encodeFrame } from "./protocol/frame"
import type { Request, Response } from "./protocol/messages"
import { EXECD_ERROR_CODES, PROTOCOL_VERSION } from "./protocol/messages"
import { peerCredentialsOf } from "./protocol/peercred"
import { SessionManager } from "./session-manager"
import { EventStream } from "./event-stream"
import type { StateStore } from "./state/store"

export interface ExecdServerDeps {
  sockPath: string
  state: StateStore
  /** L1-D：Cell/Run 操作（server 保持路由薄层）。 */
  submitCell: (payload: import("./protocol/messages").SubmitCellPayload, idempotencyKey: string, sessionId: string) => Promise<{ cellId: string; runId: string; idempotent: boolean }>
  getCell: (cellId: string) => import("./state/store").CellRecord | undefined
  cancelCell: (cellId: string) => Promise<void>
  cancelAgent: (agentId: string) => Promise<void>
  cancelRun: (runId: string) => Promise<void>
  cleanupRun: (runId: string) => Promise<{ removed: number }>
  acquireLease: (runId: string, ttlMs: number) => Promise<{ leaseId: string; expiresAt: number }>
  renewLease: (leaseId: string, ttlMs: number) => Promise<{ expiresAt: number } | undefined>
  releaseLease: (leaseId: string) => Promise<void>
  listRecoverableRuns: () => Array<{ runId: string; cellCount: number }>
}

interface Connection {
  socket: net.Socket
  codec: FrameCodec
  sessionId?: string
  peerUid?: number
  /** WatchCell 订阅（cellId + 服务端已送达断点）。 */
  watchingCell?: { cellId: string; lastAcknowledged: number }
}

export class ExecdServer {
  private server?: net.Server
  private readonly connections = new Set<Connection>()

  constructor(
    private readonly deps: ExecdServerDeps,
    private readonly sessions = new SessionManager(),
    private readonly events = new EventStream(),
    /** 对端凭据获取器（可注入测试；默认 SO_PEERCRED ffi）。 */
    private readonly peerCredentialFn: (socket: unknown) => import("./protocol/peercred").PeerCredentials | undefined = peerCredentialsOf,
  ) {}

  async start(): Promise<void> {
    const { sockPath } = this.deps
    // 目录 0700 + socket 0600：仅同用户可访问。
    mkdirSync(dirname(sockPath), { recursive: true, mode: 0o700 })
    this.server = net.createServer(socket => this.handleConnection(socket as net.Socket))
    const listen = (): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject)
        this.server!.listen(sockPath, () => {
          chmodSync(sockPath, 0o600)
          resolve()
        })
      })
    try {
      await listen()
    } catch (error) {
      // M5 修复：EADDRINUSE 时先活探测 —— 路径被活跃实例占用则拒绝
      // 双实例（绝不 unlink 正在监听的 socket）；孤儿残留文件才清理重试。
      const code = (error as NodeJS.ErrnoException).code
      if (code === "EADDRINUSE") {
        if (await probeSocketAlive(sockPath)) throw error
        rmSync(sockPath, { force: true })
        await listen()
      } else {
        throw error
      }
    }
  }

  async stop(): Promise<void> {
    for (const conn of this.connections) conn.socket.destroy()
    this.connections.clear()
    if (this.server) {
      await new Promise<void>(resolve => this.server!.close(() => resolve()))
      this.server = undefined
    }
  }

  /** 事件广播入口（CellManager 执行时调用；eventSequence 单调分配）。
   *  只推送给订阅了该 Cell 的连接（EVENT_SEQUENCE_GAP_UNDETECTED）。 */
  publishEvent(event: Omit<import("./protocol/events").ServerEvent, "eventSequence" | "type" | "at">, sequence: number, at = Date.now()): void {
    const full = this.events.publish(event, sequence, at)
    for (const conn of this.connections) {
      const watching = conn.watchingCell
      if (watching && watching.cellId === event.cellId) {
        this.send(conn, full)
        if (sequence > watching.lastAcknowledged) {
          watching.lastAcknowledged = sequence
        }
      }
    }
  }

  private handleConnection(socket: net.Socket): void {
    const conn: Connection = { socket, codec: new FrameCodec() }
    // SO_PEERCRED：连接建立时的对端凭据（不信任自报身份）。
    conn.peerUid = this.peerCredentialFn(socket)?.uid
    this.connections.add(conn)
    socket.on("data", chunk => {
      try {
        const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk
        for (const frame of conn.codec.feed(buf)) this.handleFrame(conn, frame.payload)
      } catch (error) {
        this.send(conn, { type: "error", requestId: "", error: { code: EXECD_ERROR_CODES.BAD_FRAME, message: error instanceof Error ? error.message : String(error) } })
        socket.destroy()
      }
    })
    socket.on("close", () => {
      this.connections.delete(conn)
      if (conn.sessionId) this.sessions.remove(conn.sessionId)
    })
    socket.on("error", () => { /* 连接级错误：close 清理 */ })
  }

  private handleFrame(conn: Connection, payload: string): void {
    let request: Request
    try {
      request = JSON.parse(payload) as Request
    } catch {
      this.send(conn, { type: "error", requestId: "", error: { code: EXECD_ERROR_CODES.BAD_REQUEST, message: "invalid JSON" } })
      return
    }
    // 协议版本校验（Hello 之前也校验）。
    if (request.protocolVersion !== PROTOCOL_VERSION) {
      this.send(conn, {
        type: "error", requestId: request.requestId,
        error: { code: EXECD_ERROR_CODES.PROTOCOL_VERSION_MISMATCH, message: `protocol ${request.protocolVersion} unsupported` },
      })
      return
    }
    // 认证：对端 uid 必须等于本进程 uid（ffi 不可用时 peerUid undefined →
    // 降级为仅文件权限；显式记录降级不静默）。
    if (conn.peerUid !== undefined && conn.peerUid !== (process.getuid?.() ?? -1)) {
      this.send(conn, {
        type: "error", requestId: request.requestId,
        error: { code: EXECD_ERROR_CODES.UNAUTHENTICATED, message: `peer uid ${conn.peerUid} is not the execd owner` },
      })
      conn.socket.destroy()
      return
    }
    this.dispatch(conn, request)
  }

  private async dispatch(conn: Connection, request: Request): Promise<void> {
    try {
      const response = await this.route(conn, request)
      if (response) this.send(conn, response)
    } catch (error) {
      this.send(conn, {
        type: "error", requestId: request.requestId,
        error: { code: EXECD_ERROR_CODES.INTERNAL, message: error instanceof Error ? error.message : String(error) },
      })
    }
  }

  private async route(conn: Connection, request: Request): Promise<Response | null> {
    switch (request.method) {
      case "Hello": {
        if (!conn.sessionId) {
          const session = this.sessions.create(`s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, conn.socket, { pid: 0, uid: conn.peerUid ?? -1, gid: -1 })
          conn.sessionId = session.sessionId
        }
        return { type: "ok", requestId: request.requestId, result: { sessionId: conn.sessionId, protocolVersion: PROTOCOL_VERSION, peerUid: conn.peerUid ?? null } }
      }
      case "GetCell": {
        const cell = this.deps.getCell(request.payload.cellId)
        if (!cell) {
          return { type: "error", requestId: request.requestId, error: { code: EXECD_ERROR_CODES.UNKNOWN_CELL, message: `cell ${request.payload.cellId} not found` } }
        }
        return { type: "ok", requestId: request.requestId, result: cell }
      }
      case "SubmitCell": {
        const result = await this.deps.submitCell(request.payload, request.idempotencyKey, conn.sessionId ?? "anon")
        return { type: "ok", requestId: request.requestId, result }
      }
      case "CancelCell":
        await this.deps.cancelCell(request.payload.cellId)
        return { type: "ok", requestId: request.requestId, result: { cellId: request.payload.cellId } }
      case "CancelAgent":
        await this.deps.cancelAgent(request.payload.agentId)
        return { type: "ok", requestId: request.requestId, result: { agentId: request.payload.agentId } }
      case "CancelRun":
        await this.deps.cancelRun(request.payload.runId)
        return { type: "ok", requestId: request.requestId, result: { runId: request.payload.runId } }
      case "CleanupRun": {
        const result = await this.deps.cleanupRun(request.payload.runId)
        return { type: "ok", requestId: request.requestId, result }
      }
      case "AcquireLease": {
        const result = await this.deps.acquireLease(request.payload.runId, request.payload.ttlMs)
        return { type: "ok", requestId: request.requestId, result }
      }
      case "RenewLease": {
        const result = await this.deps.renewLease(request.payload.leaseId, request.payload.ttlMs)
        if (!result) {
          return { type: "error", requestId: request.requestId, error: { code: EXECD_ERROR_CODES.LEASE_INVALID, message: `lease ${request.payload.leaseId} not found or released` } }
        }
        return { type: "ok", requestId: request.requestId, result }
      }
      case "ReleaseLease":
        await this.deps.releaseLease(request.payload.leaseId)
        return { type: "ok", requestId: request.requestId, result: { leaseId: request.payload.leaseId } }
      case "ListRecoverableRuns":
        return { type: "ok", requestId: request.requestId, result: { runs: this.deps.listRecoverableRuns() } }
      case "WatchCell": {
        // M10 修复：未知 cell 拒绝（与 GetCell 行为一致，避免死订阅）。
        if (!this.deps.state.getCell(request.payload.cellId)) {
          return { type: "error", requestId: request.requestId, error: { code: EXECD_ERROR_CODES.UNKNOWN_CELL, message: `cell ${request.payload.cellId} not found` } }
        }
        // 订阅：先回 ok（确认订阅与断点），再补落库历史（since 之后），
        // 最后登记实时推送断点。帧序：ok → 历史事件 → 实时事件。
        // M11：回放格式与实时一致（落库 kind + payload 直传）。
        const since = request.payload.sinceSequence ?? 0
        const events = this.deps.state.eventsForCell(request.payload.cellId, since)
        const last = events.length > 0 ? events[events.length - 1]!.eventSequence : since
        this.send(conn, { type: "ok", requestId: request.requestId, result: { cellId: request.payload.cellId, resumedFrom: last } })
        for (const ev of events) {
          const kind = kindOfEvent(ev)
          const payload = payloadOfEvent(ev)
          this.send(conn, { type: "event", eventSequence: ev.eventSequence, kind, cellId: ev.cellId, runId: this.deps.state.getCell(ev.cellId)?.runId, payload, at: ev.at })
        }
        conn.watchingCell = { cellId: request.payload.cellId, lastAcknowledged: last }
        return null
      }
      default:
        return { type: "error", requestId: request.requestId, error: { code: EXECD_ERROR_CODES.UNKNOWN_METHOD, message: `unknown method: ${(request as { method: string }).method}` } }
    }
  }

  private send(conn: Connection, message: Response | import("./protocol/events").ServerEvent): void {
    try {
      conn.socket.write(encodeFrame(JSON.stringify(message)))
    } catch {
      conn.socket.destroy()
    }
  }
}

/** M11：落库事件 → 实时线格式（kind 映射 —— 回放与实时格式一致）。 */
function kindOfEvent(ev: import("./state/store").CellEventRow): string {
  switch (ev.kind ?? "state") {
    case "stdout": return "cell.stdout"
    case "stderr": return "cell.stderr"
    case "exit": return "cell.exit"
    case "receipt": return "cell.receipt"
    default: return "cell.status"
  }
}

function payloadOfEvent(ev: import("./state/store").CellEventRow): unknown {
  if (ev.kind === "stdout" || ev.kind === "stderr") {
    return { data: ev.payload ?? "" }
  }
  if (ev.kind === "exit" || ev.kind === "receipt") {
    try { return ev.payload ? JSON.parse(ev.payload) : {} } catch { return {} }
  }
  return { state: ev.toState, fromState: ev.fromState, reasonCode: ev.reasonCode }
}

/** M5：socket 路径活探测（活跃实例 → true；孤儿残留文件 → false）。 */
function probeSocketAlive(sockPath: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection(sockPath)
    const timer = setTimeout(() => { socket.destroy(); resolve(false) }, 500)
    socket.on("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true) })
    socket.on("error", () => { clearTimeout(timer); resolve(false) })
  })
}
