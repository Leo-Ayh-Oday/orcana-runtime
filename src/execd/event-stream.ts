/** LR2-1（L1-C）：EventStream —— 事件流（eventSequence + 断点续读）。
 *
 *  - 每个事件单调递增 eventSequence（与 SQLite cell_events 行号对齐）；
 *  - 订阅者（WatchCell session）记录最后确认序号，重连后从该序号续读；
 *  - 断线期间的新事件由 StateStore.cell_events 兜底（重连时先补落库事件，
 *    再跟进内存实时流）——EVENT_SEQUENCE_GAP_UNDETECTED = 0。
 */

import type { ServerEvent } from "./protocol/events"

export interface EventSubscription {
  cellId: string
  /** 订阅者最后确认的 eventSequence（重连续读基线）。 */
  lastAcknowledged: number
  /** 实时推送队列（未落库事件的增量）。 */
  live: ServerEvent[]
}

export class EventStream {
  private readonly subscriptions = new Map<string, EventSubscription>()

  /** 订阅 Cell 事件流；返回订阅句柄。 */
  subscribe(cellId: string, sinceSequence = 0): EventSubscription {
    const existing = this.subscriptions.get(cellId)
    if (existing) return existing
    const sub: EventSubscription = { cellId, lastAcknowledged: sinceSequence, live: [] }
    this.subscriptions.set(cellId, sub)
    return sub
  }

  unsubscribe(cellId: string): void {
    this.subscriptions.delete(cellId)
  }

  /** 广播事件：落库事件（sequence 已知）直接推送；实时事件分配序号。 */
  publish(event: Omit<ServerEvent, "eventSequence" | "type" | "at">, sequence: number, at = Date.now()): ServerEvent {
    const full: ServerEvent = { type: "event", eventSequence: sequence, ...event, at }
    for (const sub of this.subscriptions.values()) {
      if (sub.cellId !== event.cellId) continue
      if (sequence > sub.lastAcknowledged) sub.live.push(full)
    }
    return full
  }

  /** 订阅者确认已消费到该序号（推进断点基线）。 */
  acknowledge(sub: EventSubscription, sequence: number): void {
    if (sequence > sub.lastAcknowledged) sub.lastAcknowledged = sequence
    // 清理已确认的实时增量（内存有界）。
    sub.live = sub.live.filter(e => e.eventSequence > sequence)
  }

  /** 拉取订阅者的待投递事件（实时增量；落库历史由调用方从 store 补）。 */
  drain(sub: EventSubscription): ServerEvent[] {
    const out = [...sub.live]
    sub.live = []
    return out
  }
}
