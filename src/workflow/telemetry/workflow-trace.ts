/** Workflow projector (G0): trace event stream → execution graph projection.
 *
 *  Shadow mode (plan PR-G0): the projector is a pure, synchronous observer
 *  over the existing run-trace event stream. It never changes execution
 *  behavior — it only records what the run already did and produces a
 *  serializable WorkflowSnapshot at the end.
 *
 *  Projection rules (mapped to the real event vocabulary):
 *    - agent_loop_started        → root node
 *    - round_started             → "round:N" virtual node
 *    - thinking_decision /
 *      model_selected /
 *      token_usage / round_output → merged into the current round node data
 *    - tool_call                 → "tool:<callId>" node (contains edge from round)
 *    - tool_result               → terminal status on that tool node
 *    - gate_decision             → "gate:<round>:<gate>" node (decisions accumulate)
 *    - verification_result       → "verification:<round>:<ordinal>" node
 *    - epoch_rollover            → "gate:epoch_rollover" node
 *    - agent_loop_finished /
 *      agent_loop_aborted /
 *      agent_loop_blocked        → terminal status on the root node
 *
 *  Input payloads are never stored verbatim: tool inputs are reduced to
 *  a parameter-key summary, and the snapshot passes through
 *  redactForTrace at the write boundary regardless.
 */

import type { WorkflowSnapshot, WorkflowNode, WorkflowNodeStatus, WorkflowTraceEvent } from "../types"
import { WORKFLOW_SNAPSHOT_SCHEMA } from "./graph-snapshot"

const MAX_PROMPT_CHARS = 1000
const MAX_GATE_DECISIONS = 12
const MAX_NODES = 10_000

interface RoundCtx {
  nodeId: string
  lastToolIndex: number
  lastVerificationIndex: number
}

export class WorkflowProjector {
  private readonly runId: string
  private readonly prompt: string
  private readonly startedAt: number
  private finishedAt?: number
  private decision?: string

  private nodes: WorkflowNode[] = []
  private readonly edges: Array<{ from: string; to: string; kind: "contains" | "produces" | "gates" }> = []
  private readonly nodeById = new Map<string, WorkflowNode>()
  private currentRound: RoundCtx | undefined
  private metrics = {
    rounds: 0,
    toolCalls: 0,
    toolFailures: 0,
    gateDecisions: 0,
    gateBlocks: 0,
    verifications: 0,
    planNodes: 0,
  }

  constructor(runId: string, prompt: string) {
    this.runId = runId
    this.prompt = prompt.slice(0, MAX_PROMPT_CHARS)
    this.startedAt = Date.now()
  }

  /** Pure projection step — call for every run-trace event. Never throws. */
  observe(type: string, data?: unknown): void {
    try {
      this.observeInternal(type, data as Record<string, unknown> | undefined)
    } catch {
      // Projection must never fail the run (same policy as trace writes).
    }
  }

  private observeInternal(type: string, data?: Record<string, unknown>): void {
    if (this.nodes.length >= MAX_NODES) return

    switch (type) {
      case "agent_loop_started": {
        const root: WorkflowNode = {
          id: "root:run",
          kind: "root",
          name: "run",
          status: "active",
          startedAt: this.startedAt,
          round: -1,
          data: {
            maxRounds: numberOf(data?.maxRounds),
            toolCount: numberOf(data?.toolCount),
          },
        }
        this.addNode(root)
        return
      }
      case "round_started": {
        const round = numberOr(data?.round, -1)
        const node: WorkflowNode = {
          id: `round:${round}`,
          kind: "round",
          name: `round:${round}`,
          status: "active",
          startedAt: Date.now(),
          round,
        }
        this.addNode(node)
        this.link("root:run", node.id, "contains")
        this.currentRound = { nodeId: node.id, lastToolIndex: 0, lastVerificationIndex: 0 }
        this.metrics.rounds++
        return
      }
      case "thinking_decision":
      case "model_selected":
      case "cache_prefix_shape":
      case "provider_status": {
        this.mergeRoundData(type, data)
        return
      }
      case "token_usage":
      case "round_output": {
        // Token/budget figures are metering numbers (redactor-exempt); keep
        // only scalars so the snapshot stays small and safe.
        this.mergeRoundData(type, pickScalars(data))
        return
      }
      case "tool_call": {
        const id = stringOr(data?.id, `call_${this.metrics.toolCalls}`)
        const round = numberOr(data?.round, -1)
        const node: WorkflowNode = {
          id: `tool:${id}`,
          kind: "tool",
          name: stringOr(data?.tool, "unknown"),
          status: "active",
          startedAt: Date.now(),
          round,
          data: { inputKeys: inputKeySummary(data?.input) },
        }
        this.addNode(node)
        const parent = this.parentRound(round)
        if (parent) this.link(parent, node.id, "contains")
        this.metrics.toolCalls++
        return
      }
      case "tool_result": {
        const id = stringOr(data?.id, "")
        const node = this.nodeById.get(`tool:${id}`)
        if (!node) return
        node.status = data?.blocked ? "blocked" : data?.success === false ? "failed" : "done"
        node.finishedAt = Date.now()
        node.durationMs = durationMs(node, data?.durationMs)
        if (node.status === "failed" || node.status === "blocked") this.metrics.toolFailures++
        return
      }
      case "gate_decision": {
        const round = numberOr(data?.round, this.currentRound?.nodeId ? this.roundOf(this.currentRound.nodeId) : -1)
        const gate = stringOr(data?.gate, "unknown")
        const decision = stringOr(data?.decision, "")
        const nodeId = `gate:${round}:${gate}`
        const existing = this.nodeById.get(nodeId)
        if (existing) {
          const decisions = (existing.data?.decisions as string[]) ?? []
          if (decisions.length < MAX_GATE_DECISIONS) {
            decisions.push(decision)
            existing.data = { ...existing.data, decisions }
          }
        } else {
          const node: WorkflowNode = {
            id: nodeId,
            kind: "gate",
            name: gate,
            status: decision === "block" || decision === "replan" ? "blocked" : "done",
            startedAt: Date.now(),
            finishedAt: Date.now(),
            round,
            data: { decisions: [decision] },
          }
          this.addNode(node)
          const parent = this.parentRound(round)
          if (parent) this.link(parent, nodeId, "gates")
        }
        this.metrics.gateDecisions++
        if (decision === "block") this.metrics.gateBlocks++
        return
      }
      case "epoch_rollover": {
        const round = numberOr(data?.round, this.currentRound?.nodeId ? this.roundOf(this.currentRound.nodeId) : -1)
        const nodeId = `gate:${round}:epoch_rollover`
        if (this.nodeById.has(nodeId)) return
        const node: WorkflowNode = {
          id: nodeId,
          kind: "gate",
          name: "epoch_rollover",
          status: "done",
          startedAt: Date.now(),
          finishedAt: Date.now(),
          round,
          data: { archivedCount: numberOf(data?.archivedCount), charsTrimmed: numberOf(data?.charsTrimmed) },
        }
        this.addNode(node)
        this.metrics.gateDecisions++
        return
      }
      case "verification_result": {
        const round = numberOr(data?.round, this.currentRound?.nodeId ? this.roundOf(this.currentRound.nodeId) : -1)
        const ctx = this.currentRound
        const ordinal = ctx ? ++ctx.lastVerificationIndex : 0
        const node: WorkflowNode = {
          id: `verification:${round}:${ordinal}`,
          kind: "verification",
          name: "verification",
          status: data?.passed === false ? "failed" : data?.success === false ? "failed" : "done",
          startedAt: Date.now(),
          finishedAt: Date.now(),
          round,
          data: pickScalars(data),
        }
        this.addNode(node)
        const parent = this.parentRound(round)
        if (parent) this.link(parent, node.id, "produces")
        this.metrics.verifications++
        return
      }
      case "agent_loop_finished":
      case "agent_loop_aborted":
      case "agent_loop_blocked": {
        this.finish(type, data)
        return
      }
      default:
        return
    }
  }

  private finish(type: string, data?: Record<string, unknown>): void {
    const root = this.nodeById.get("root:run")
    const status: WorkflowNodeStatus =
      type === "agent_loop_finished" ? "done" : type === "agent_loop_blocked" ? "blocked" : "failed"
    if (root) {
      root.status = status
      root.finishedAt = Date.now()
    }
    if (this.currentRound) {
      const roundNode = this.nodeById.get(this.currentRound.nodeId)
      if (roundNode && roundNode.status === "active") roundNode.status = "done"
    }
    this.finishedAt = Date.now()
    this.decision = stringOr(data?.reason, type)
  }

  /** Build the final snapshot. */
  snapshot(): WorkflowSnapshot {
    const nodes = [...this.nodes]
    const sorted = [...this.edges].sort((a, b) => {
      const order = (n: string) => (n === "root:run" ? 0 : 1)
      return order(a.from) - order(b.from)
    })
    return {
      schemaVersion: WORKFLOW_SNAPSHOT_SCHEMA,
      mode: "shadow",
      runId: this.runId,
      prompt: this.prompt,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      decision: this.decision,
      nodes,
      edges: sorted,
      metrics: { ...this.metrics },
    }
  }

  private addNode(node: WorkflowNode): void {
    this.nodes.push(node)
    this.nodeById.set(node.id, node)
  }

  private link(from: string, to: string, kind: "contains" | "produces" | "gates"): void {
    this.edges.push({ from, to, kind })
  }

  private parentRound(round: number): string | undefined {
    if (round >= 0) {
      const node = this.nodeById.get(`round:${round}`)
      if (node) return node.id
    }
    return this.currentRound?.nodeId
  }

  private roundOf(nodeId: string): number {
    const node = this.nodeById.get(nodeId)
    return node ? node.round : -1
  }

  private mergeRoundData(type: string, data?: Record<string, unknown>): void {
    if (!this.currentRound) return
    const node = this.nodeById.get(this.currentRound.nodeId)
    if (!node || !data) return
    node.data = { ...node.data, [type]: data }
  }
}

// ── Wrapper: project every runTrace.record() without touching call sites ──

import { appendFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { serializeSnapshot } from "./graph-snapshot"

/** Minimal run-trace surface the projector wrapper needs. */
export interface TraceLike {
  record(type: string, data?: unknown): void
  runId: string
  file: string
}

/** ProjectingRunTrace: delegates every record() to the inner trace AND the
 *  projector; persists the graph snapshot once the run reaches a terminal
 *  event. Writes are best-effort — projection never fails the run. */
export class ProjectingRunTrace implements TraceLike {
  readonly runId: string
  readonly file: string
  readonly projector: WorkflowProjector

  private readonly inner: TraceLike
  private saved = false

  constructor(inner: TraceLike, projector: WorkflowProjector) {
    this.inner = inner
    this.runId = inner.runId
    this.file = inner.file
    this.projector = projector
  }

  record(type: string, data?: unknown): void {
    this.inner.record(type, data)
    this.projector.observe(type, data)
    if (!this.saved && (type === "agent_loop_finished" || type === "agent_loop_aborted" || type === "agent_loop_blocked")) {
      this.saved = true
      this.saveSnapshot()
    }
  }

  /** Best-effort persist of the current snapshot. */
  saveSnapshot(): void {
    try {
      const snapshot = this.projector.snapshot()
      const dir = join(dirname(this.file), "..", "workflow")
      mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, `${this.runId}.graph.json`), serializeSnapshot(snapshot), "utf-8")
    } catch {
      // Never fail the run over a telemetry write.
    }
  }
}

/** Wrap a run trace in shadow projection ("off" returns it unchanged).
 *  "readonly" mode projects identically (G1 execution happens out-of-band). */
export function wrapRunTrace(
  runTrace: TraceLike,
  mode: "off" | "shadow" | "readonly",
  prompt: string,
): { trace: TraceLike; projector?: WorkflowProjector } {
  if (mode === "off") return { trace: runTrace }
  const projector = new WorkflowProjector(runTrace.runId, prompt)
  return { trace: new ProjectingRunTrace(runTrace, projector), projector }
}

// ── Helpers (defensive number/string extraction from unknown data) ──

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback
}

function durationMs(node: WorkflowNode, reported: unknown): number | undefined {
  if (typeof reported === "number" && Number.isFinite(reported) && reported >= 0) return reported
  if (node.startedAt) return Date.now() - node.startedAt
  return undefined
}

/** Reduce a tool input to a safe parameter-key summary (never values). */
function inputKeySummary(input: unknown): string[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return []
  return Object.keys(input as Record<string, unknown>).slice(0, 24)
}

/** Keep only scalar payload fields (numbers/booleans/short strings). */
function pickScalars(data?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!data) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "number" || typeof value === "boolean") out[key] = value
    else if (typeof value === "string" && value.length <= 120) out[key] = value
  }
  return out
}
