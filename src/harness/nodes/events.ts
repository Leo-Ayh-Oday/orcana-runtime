/** Node event emitter (H11).
 *
 *  NodeEvent is a side stream: each event is stamped with nodeRunId and a
 *  node-local sequence, then appended to the run's TraceWriter as an
 *  EventEnvelope (the H0 schema already carries nodeRunId). The node stream
 *  never touches run.eventSequence — the run's own event stream stays
 *  contiguous (H12 records the caveat).
 */

import type { EventEnvelope } from "../contracts/events"
import { HARNESS_EVENT_SCHEMA_VERSION } from "../contracts/events"
import type { NodeEvent, NodeExecutionContext } from "../contracts/nodes"

export interface NodeEventEmitter {
  emit(event: NodeEvent): Promise<void>
}

export function createNodeEventEmitter(context: NodeExecutionContext): NodeEventEmitter {
  let sequence = 0

  return {
    async emit(event: NodeEvent): Promise<void> {
      sequence += 1
      const envelope: EventEnvelope = {
        schemaVersion: HARNESS_EVENT_SCHEMA_VERSION,
        eventId: `${context.nodeRunId}:${sequence}`,
        sequence,
        runId: context.runId,
        sessionId: context.runScope.sessionId,
        nodeRunId: context.nodeRunId,
        type: event.type,
        timestamp: new Date().toISOString(),
        payload: event,
      }
      try {
        await context.trace.append(envelope)
      } catch {
        // Best-effort: trace failures never break node execution.
      }
    },
  }
}
