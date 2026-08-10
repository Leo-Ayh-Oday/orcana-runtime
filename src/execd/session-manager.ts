/** LR2-1（L1-C）：SessionManager —— 连接会话 + WatchCell 订阅。
 *
 *  - sessionId ↔ 连接（socket）映射；Hello 建立会话；
 *  - 会话携带对端凭据（SO_PEERCRED：pid/uid/gid——不信任自报身份）；
 *  - 断线时保留订阅断点（EventStream），重连后从 lastAcknowledged 续读。
 */

import type { PeerCredentials } from "./protocol/peercred"

export interface Session {
  sessionId: string
  socket: unknown
  peer: PeerCredentials | undefined
  connectedAt: number
  /** WatchCell 订阅（cellId → 断点）。 */
  watching: Map<string, { lastAcknowledged: number }>
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>()

  create(sessionId: string, socket: unknown, peer: PeerCredentials | undefined): Session {
    const session: Session = { sessionId, socket, peer, connectedAt: Date.now(), watching: new Map() }
    this.sessions.set(sessionId, session)
    return session
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId)
  }

  remove(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /** 会话对端 uid（无凭据时 undefined —— 认证层显式处理降级）。 */
  peerUid(sessionId: string): number | undefined {
    return this.sessions.get(sessionId)?.peer?.uid
  }

  /** 会话数（测试/观测）。 */
  get size(): number {
    return this.sessions.size
  }
}
