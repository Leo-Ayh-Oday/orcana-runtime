/** LR2-5（P5-A）：Service 状态机 —— 9 态主链 + 6 异常终态。
 *
 *  DECLARED → STARTING → PROCESS_RUNNING → READINESS_PENDING → READY
 *  → DEGRADED → RESTARTING → STOPPING → STOPPED
 *  异常：START_FAILED / HEALTH_FAILED / LEASE_EXPIRED / OWNER_LOST /
 *  PORT_CONFLICT / RESTART_EXHAUSTED。
 *
 *  守卫式迁移（同 execd transition 模式）：非法迁移拒绝 + append-only
 *  事件记录。服务节点走 SERVICE_READY 语义（不使用短任务完成语义）。
 */

export type ServiceState =
  | "DECLARED"
  | "STARTING"
  | "PROCESS_RUNNING"
  | "READINESS_PENDING"
  | "READY"
  | "DEGRADED"
  | "RESTARTING"
  | "STOPPING"
  | "STOPPED"
  // 异常终态
  | "START_FAILED"
  | "HEALTH_FAILED"
  | "LEASE_EXPIRED"
  | "OWNER_LOST"
  | "PORT_CONFLICT"
  | "RESTART_EXHAUSTED"

export const SERVICE_TERMINAL_STATES: ReadonlySet<ServiceState> = new Set<ServiceState>([
  "STOPPED", "START_FAILED", "HEALTH_FAILED", "LEASE_EXPIRED",
  "OWNER_LOST", "PORT_CONFLICT", "RESTART_EXHAUSTED",
])

/** 合法迁移表（from → to 集合）。 */
export const SERVICE_TRANSITIONS: Readonly<Record<ServiceState, ReadonlySet<ServiceState>>> = {
  DECLARED: new Set(["STARTING", "START_FAILED"]),
  STARTING: new Set(["PROCESS_RUNNING", "START_FAILED", "STOPPING"]),
  PROCESS_RUNNING: new Set(["READINESS_PENDING", "READY", "START_FAILED", "STOPPING", "RESTARTING"]),
  // M4（LR2-5 审核）：READINESS_PENDING 期间进程死亡 → 重启（不卡探测）
  READINESS_PENDING: new Set(["READY", "HEALTH_FAILED", "START_FAILED", "STOPPING", "RESTARTING"]),
  READY: new Set(["DEGRADED", "STOPPING", "RESTARTING", "LEASE_EXPIRED", "OWNER_LOST"]),
  DEGRADED: new Set(["READY", "RESTARTING", "STOPPING", "LEASE_EXPIRED", "OWNER_LOST"]),
  RESTARTING: new Set(["PROCESS_RUNNING", "RESTART_EXHAUSTED", "STOPPING", "START_FAILED"]),
  STOPPING: new Set(["STOPPED", "HEALTH_FAILED"]),
  STOPPED: new Set([]),
  START_FAILED: new Set([]),
  HEALTH_FAILED: new Set([]),
  LEASE_EXPIRED: new Set([]),
  OWNER_LOST: new Set([]),
  PORT_CONFLICT: new Set([]),
  RESTART_EXHAUSTED: new Set([]),
}

export interface ServiceEvent {
  sequence: number
  serviceId: string
  from: ServiceState | null
  to: ServiceState
  reason: string
  at: number
}

export class ServiceStateMachine {
  private state: ServiceState = "DECLARED"
  private readonly history: ServiceEvent[] = []
  private sequence = 0

  constructor(private readonly serviceId: string, private readonly now: () => number = Date.now) {}

  get current(): ServiceState {
    return this.state
  }

  /** 守卫式迁移：非法迁移返回 false（不记录、不改变状态）。 */
  transition(to: ServiceState, reason: string): boolean {
    if (to === this.state) return false
    const allowed = SERVICE_TRANSITIONS[this.state]
    if (!allowed.has(to)) return false
    this.history.push({
      sequence: ++this.sequence,
      serviceId: this.serviceId,
      from: this.state,
      to,
      reason,
      at: this.now(),
    })
    this.state = to
    return true
  }

  /** 强制迁移（异常终态入口 —— 如外部 lease 到期直接置 LEASE_EXPIRED）。 */
  /** 强制迁移（异常终态入口 —— 如外部 lease 到期直接置 LEASE_EXPIRED）。
   *  m9（LR2-5 审核）：守卫 —— 目标必须是异常终态，且当前非终态
   *  （终态不可再 force；表外迁移不得污染事件流）。 */
  force(to: ServiceState, reason: string): boolean {
    const ABNORMAL = new Set<ServiceState>([
      "START_FAILED", "HEALTH_FAILED", "LEASE_EXPIRED", "OWNER_LOST", "PORT_CONFLICT", "RESTART_EXHAUSTED",
    ])
    if (!ABNORMAL.has(to)) return false
    if (this.isTerminal) return false
    this.history.push({
      sequence: ++this.sequence,
      serviceId: this.serviceId,
      from: this.state,
      to,
      reason,
      at: this.now(),
    })
    this.state = to
    return true
  }

  get isTerminal(): boolean {
    return SERVICE_TERMINAL_STATES.has(this.state)
  }

  events(): readonly ServiceEvent[] {
    return this.history
  }
}
