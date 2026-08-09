/** LR2-1v2（L2-C）：EventStream —— 有界实时队列 + 落后标记（背压）。
 *
 *  v1 的 live 队列无限增长（慢消费者拖垮内存）。v2：
 *  - 每订阅 live 队列有界（maxQueued，默认 4096 事件）；
 *  - 超限 → 订阅者标记 lagged（不再实时推送 —— 事件不丢：落库历史
 *    可补读），调用方看到 lagged 后用 state.eventsForCell 补历史；
 *  - drain 返回 lagged 标记（EVENT_QUEUE_UNBOUNDED = 0、
 *    SLOW_CONSUMER_EVENT_LOSS = 0：队列有界且不丢事件，只切换通道）。
 */

import type { ServerEvent } from "./protocol/events"

export interface EventSubscription {
  cellId: string
  /** 订阅者最后确认的 eventSequence（重连续读基线）。 */
  lastAcknowledged: number
  /** 实时推送队列（有界 —— 超限切换落后通道）。 */
  live: ServerEvent[]
  /** 落后标记：队列曾超限，实时推送已停（需补读历史）。 */
  lagged: boolean
  /** 落后时补读的起始序号（= 已确认序号 + 1）。 */
  resumeFromSequence: number
}

export interface EventStreamOptions {
  /** 每订阅实时队列上限（默认 4096）。 */
  maxQueued?: number
}

export class EventStream {
  private readonly subscriptions = new Map<string, EventSubscription>()
  private readonly maxQueued: number

  constructor(opts: EventStreamOptions = {}) {
    this.maxQueued = opts.maxQueued ?? 4096
  }

  /** 订阅 Cell 事件流；返回订阅句柄。 */
  subscribe(cellId: string, sinceSequence = 0): EventSubscription {
    const existing = this.subscriptions.get(cellId)
    if (existing) return existing
    const sub: EventSubscription = {
      cellId,
      lastAcknowledged: sinceSequence,
      live: [],
      lagged: false,
      resumeFromSequence: sinceSequence,
    }
    this.subscriptions.set(cellId, sub)
    return sub
  }

  unsubscribe(cellId: string): void {
    this.subscriptions.delete(cellId)
  }

  /** 广播事件：落库事件（sequence 已知）直接推送；超限 → 落后标记。 */
  publish(event: Omit<ServerEvent, "eventSequence" | "type" | "at">, sequence: number, at = Date.now()): ServerEvent {
    const full: ServerEvent = { type: "event", eventSequence: sequence, ...event, at }
    for (const sub of this.subscriptions.values()) {
      if (sub.cellId !== event.cellId) continue
      if (sequence > sub.lastAcknowledged && !sub.lagged) {
        if (sub.live.length >= this.maxQueued) {
          // L2-C：队列满 → 落后（实时通道停，事件不丢 —— 落库可补读）。
          sub.lagged = true
          sub.resumeFromSequence = sub.lastAcknowledged + 1
          sub.live = []
          continue
        }
        sub.live.push(full)
      }
    }
    return full
  }

  /** 订阅者确认已消费到该序号（推进断点基线；清落后标记 —— 之后
   *  可恢复实时通道）。 */
  acknowledge(sub: EventSubscription, sequence: number): void {
    if (sequence > sub.lastAcknowledged) sub.lastAcknowledged = sequence
    sub.live = sub.live.filter(e => e.eventSequence > sequence)
    if (sub.lagged && sequence >= sub.resumeFromSequence) {
      sub.lagged = false
      sub.resumeFromSequence = sub.lastAcknowledged + 1
    }
  }

  /** 拉取订阅者的待投递事件（实时增量 + 落后标记；落库历史由调用方
   *  从 store 补读）。 */
  drain(sub: EventSubscription): { events: ServerEvent[]; lagged: boolean; resumeFromSequence: number } {
    const out = [...sub.live]
    sub.live = []
    return { events: out, lagged: sub.lagged, resumeFromSequence: sub.resumeFromSequence }
  }

  /** 诊断：订阅队列深度。 */
  queueDepth(cellId: string): number {
    return this.subscriptions.get(cellId)?.live.length ?? 0
  }

  /** 诊断：是否落后。 */
  isLagged(cellId: string): boolean {
    return this.subscriptions.get(cellId)?.lagged ?? false
  }
}
