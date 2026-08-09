/** LR2-1v2（L2-C）验收：事件背压（有界队列 + 落后标记）。 */

import { describe, test, expect } from "bun:test"
import { EventStream } from "../../../src/execd/event-stream"
import type { ServerEvent } from "../../../src/execd/protocol/events"

function ev(seq: number, cellId = "cell-1"): Omit<ServerEvent, "eventSequence" | "type" | "at"> {
  return { kind: "cell.status", cellId, payload: { state: "RUNNING" } }
}

describe("L2-C: EventStream backpressure", () => {
  test("events delivered in order until acknowledged", () => {
    const es = new EventStream()
    const sub = es.subscribe("cell-1")
    es.publish(ev(1), 1)
    es.publish(ev(2), 2)
    const d = es.drain(sub)
    expect(d.events.map(e => e.eventSequence)).toEqual([1, 2])
    expect(d.lagged).toBe(false)
    es.acknowledge(sub, 2)
    expect(sub.lastAcknowledged).toBe(2)
  })

  test("EVENT_QUEUE_UNBOUNDED: queue is bounded (lag after maxQueued)", () => {
    const es = new EventStream({ maxQueued: 4 })
    const sub = es.subscribe("cell-1")
    for (let i = 1; i <= 10; i++) es.publish(ev(i), i)
    // 前 4 个在队列，第 5 个起触发落后
    expect(sub.live.length).toBeLessThanOrEqual(4)
    expect(sub.lagged).toBe(true)
    expect(es.isLagged("cell-1")).toBe(true)
  })

  test("SLOW_CONSUMER_EVENT_LOSS: lagged subscriber keeps events recoverable via resumeFromSequence", () => {
    const es = new EventStream({ maxQueued: 2 })
    const sub = es.subscribe("cell-1")
    es.publish(ev(1), 1)
    es.publish(ev(2), 2)
    const d1 = es.drain(sub)
    expect(d1.events.length).toBe(2)
    // 已确认到 2；队列空但 maxQueued=2 → 连发 3 个事件触发落后
    es.acknowledge(sub, 2)
    es.publish(ev(3), 3)
    es.publish(ev(4), 4)
    es.publish(ev(5), 5) // 第 3 个 → 队列满 → 落后
    expect(sub.lagged).toBe(true)
    const d2 = es.drain(sub)
    expect(d2.lagged).toBe(true)
    // 事件 5 未丢失 —— resumeFromSequence 指向可补读起点（=2+1）
    expect(d2.resumeFromSequence).toBe(3)
    // 落后清不清除：确认到 5 → 恢复实时
    es.acknowledge(sub, 5)
    expect(sub.lagged).toBe(false)
  })

  test("lagged subscriber stops receiving live events (no growth)", () => {
    const es = new EventStream({ maxQueued: 2 })
    const sub = es.subscribe("cell-1")
    es.publish(ev(1), 1)
    es.publish(ev(2), 2)
    es.publish(ev(3), 3) // 触发落后
    es.publish(ev(4), 4)
    expect(sub.live.length).toBe(0) // 落后后不积压
    expect(sub.lagged).toBe(true)
  })

  test("acknowledge past lag point clears lagged", () => {
    const es = new EventStream({ maxQueued: 2 })
    const sub = es.subscribe("cell-1")
    for (let i = 1; i <= 6; i++) es.publish(ev(i), i)
    expect(sub.lagged).toBe(true)
    es.acknowledge(sub, 6)
    expect(sub.lagged).toBe(false)
    // 恢复实时通道
    es.publish(ev(7), 7)
    expect(es.drain(sub).events.map(e => e.eventSequence)).toContain(7)
  })

  test("unsubscribe stops delivery", () => {
    const es = new EventStream()
    const sub = es.subscribe("cell-1")
    es.unsubscribe("cell-1")
    es.publish(ev(1), 1)
    expect(sub.live).toHaveLength(0)
  })

  test("queueDepth diagnostic", () => {
    const es = new EventStream()
    es.subscribe("cell-1")
    es.publish(ev(1), 1)
    es.publish(ev(2), 2)
    expect(es.queueDepth("cell-1")).toBe(2)
  })
})
