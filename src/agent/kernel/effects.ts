/** RunEffect channel plumbing (ALK PR-L7).
 *
 *  drainPhase  — consumes a phase generator (prepareRun / runRound) that
 *                yields RunEffect, applies trace/state effects to the run
 *                context, forwards stream effects to the consumer, and
 *                returns the phase's LoopDecision. The close protocol
 *                mirrors the pre-L7 manual iterator drain: if the consumer
 *                closes (return()/throw()) while we are suspended, the phase
 *                generator is returned so its own finally blocks (provider
 *                iterator cleanup, sandbox reset) still run.
 *  wrapEvents  — adapts the L4–L6 coordinator generators
 *                (AsyncGenerator<StreamEvent, T>) into RunEffect streams,
 *                passing through their return value and close signal.
 *
 *  Gate telemetry is collector-scoped: gates record into the GateTelemetry
 *  instance by reference (pre-round chain, CompletionOrchestrator), so it is
 *  not a per-event effect. flushTelemetry() is the single save point.
 */

import type { StreamEvent } from "../../provider/types"
import type { AgentRunStatePatch } from "../run/state-patch"
import { applyAgentRunStatePatch } from "../run/state-patch"
import type { RunEffect, RunPhaseContext } from "./types"

export function stream(event: StreamEvent): RunEffect {
  return { kind: "stream", event }
}

export function trace(type: string, data?: unknown): RunEffect {
  return { kind: "trace", type, data }
}

export function patch(patch: AgentRunStatePatch): RunEffect {
  return { kind: "state", patch }
}

/** Drain a phase generator: apply effects, forward stream events, return decision. */
export async function* drainPhase<T>(
  phase: AsyncGenerator<RunEffect, T, unknown>,
  ctx: RunPhaseContext,
): AsyncGenerator<StreamEvent, T, unknown> {
  let closed = false
  try {
    while (true) {
      const step = await phase.next()
      if (step.done) {
        closed = true
        return step.value as T
      }
      const effect = step.value
      if (effect.kind === "stream") {
        yield effect.event
      } else if (effect.kind === "trace") {
        ctx.runTrace?.record(effect.type, effect.data)
      } else {
        applyAgentRunStatePatch(ctx.runState, effect.patch)
      }
    }
  } finally {
    // Close protocol: propagate consumer close into the phase so its
    // finally blocks (provider/tool iterator cleanup) still run.
    if (!closed) {
      try {
        await phase.return(undefined as never)
      } catch {
        // Closing is best-effort — never mask the original error.
      }
    }
  }
}

/** Adapt an L4–L6 coordinator generator (StreamEvent) to a RunEffect stream. */
export async function* wrapEvents<T>(
  inner: AsyncGenerator<StreamEvent, T, unknown>,
): AsyncGenerator<RunEffect, T, unknown> {
  let closed = false
  try {
    while (true) {
      const step = await inner.next()
      if (step.done) {
        closed = true
        return step.value as T
      }
      yield { kind: "stream", event: step.value }
    }
  } finally {
    if (!closed) {
      try {
        await inner.return(undefined as never)
      } catch {
        // Best-effort close.
      }
    }
  }
}

/** Save gate telemetry to disk (best-effort), called from finalize paths. */
export async function flushTelemetry(ctx: RunPhaseContext): Promise<void> {
  if (!ctx.gateTelemetryFile) return
  if (ctx.gateTelemetry.gateNames().length === 0) return
  const path = await import("node:path")
  const fs = await import("node:fs/promises")
  const dir = path.dirname(ctx.gateTelemetryFile)
  await fs.mkdir(dir, { recursive: true }).catch(() => {})
  await ctx.gateTelemetry.saveToFile(ctx.gateTelemetryFile).catch(() => {})
}
