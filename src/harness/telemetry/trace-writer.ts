/** JSONL TraceWriter (H5): typed event envelopes to disk.
 *
 *  Writes `.orcana/harness/events/<runId>.jsonl`, one serialized
 *  EventEnvelope per line, in stream order (sequence is naturally ordered).
 *  Payloads pass through redactForTrace before serialization.
 *
 *  Failure policy (plan §12.3): append errors are swallowed so a trace write
 *  never fails the run; flush()/close() are idempotent and best-effort.
 *  Writes are batched via a queue flushed on setImmediate ticks.
 */

import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { redactForTrace } from "../../agent/secret-redactor"
import type { EventEnvelope } from "../contracts/events"
import type { TraceWriter } from "../contracts/scope"

export interface JsonlTraceWriterInput {
  dir: string
  runId: string
  sessionId: string
}

export function createJsonlTraceWriter(input: JsonlTraceWriterInput): TraceWriter {
  const file = join(input.dir, `${input.runId}.jsonl`)
  let queue: Array<EventEnvelope<unknown>> = []
  let flushScheduled = false
  let closed = false

  const writeQueue = () => {
    flushScheduled = false
    if (queue.length === 0) return
    const batch = queue
    queue = []
    try {
      mkdirSync(input.dir, { recursive: true })
      const lines = batch.map(event => `${JSON.stringify(event)}\n`).join("")
      appendFileSync(file, lines, "utf-8")
    } catch {
      // Trace writes must never fail the run (plan §12.3).
      queue = [...batch, ...queue]
    }
  }

  const scheduleFlush = () => {
    if (flushScheduled || closed) return
    flushScheduled = true
    setImmediate(writeQueue)
  }

  return {
    async append<T>(event: EventEnvelope<T>): Promise<void> {
      if (closed) return
      queue.push({
        ...event,
        payload: redactForTrace(event.payload) as T,
      } as EventEnvelope<unknown>)
      scheduleFlush()
    },

    async flush(): Promise<void> {
      if (closed) return
      writeQueue()
    },

    async close(): Promise<void> {
      if (closed) return
      writeQueue()
      closed = true
    },
  }
}
