/** Scheduler (G1–G3): parallel read-only + single-writer DAG execution.
 *
 *  G1/G2 semantics: ready queue, bounded read concurrency, failure
 *  isolation, deadlock guard, incremental checkpoints.
 *  G3 additions: read-write specs execute whitelisted write handlers
 *  under a single-writer lock (ConcurrencyController), and the completion
 *  gate rejects runs whose write nodes lack passing verification evidence
 *  (status "blocked_no_evidence").
 */

import type { WorkflowRunResult, WorkflowSpec } from "../types"
import { detectCycle } from "../results/edge-store"
import { ResultStore } from "../results/result-store"
import { ReadyQueue } from "./ready-queue"
import { ConcurrencyController } from "./concurrency-controller"
import type { HandlerRegistry } from "../execution/handler-registry"
import { executeNode } from "../execution/node-executor"
import { aggregateEvidence } from "../reducers/aggregate-evidence"
import { ResultCache, cacheKeyFor } from "../results/result-cache"
import { evaluateReadiness } from "./dependency-policy"
import { isHarnessNode } from "../harness/workflow-node-adapter"
import { createWorkflowHarnessRuntime } from "../harness/node-context-factory"
import { executeHarnessNode } from "../execution/harness-node-executor"
import type { WorkflowHarnessEnvironment } from "../harness/environment"
import { enforceNodeAssignment, enforceActualWrites, ownershipDeniedResult, createWorktreeRegistry } from "../execution/workflow-execution-context"
import type { WorkflowNodeExecutionContext } from "../agents/workspace-context"
import { WorkflowInterruptError, type WorkflowInterruptError as WIE } from "../interrupts/types"
import { createResumeToken } from "../interrupts/resume-token"
import type { ResourceLedger } from "../../runtime/linux/scheduler/resource-ledger"
import type { ResourceRequest } from "../../runtime/linux/contracts"

export interface SchedulerOptions {
  maxParallel?: number
  checkpointDir?: string
  /** G5: read-node result cache — cache hits replay instead of re-executing;
   *  a completed write node invalidates the cache. Optional; when absent
   *  the scheduler behaves exactly as before (old-run compatibility). */
  cache?: ResultCache
  /** G7: agent pool — cancelled agents fail fast, per-agent budgets are
   *  charged. Optional; absent = single-agent semantics unchanged. */
  pool?: import("../agents/agent-pool").AgentPool
  /** MACP-M2: H11 harness environment. Nodes declaring an H11 execution
   *  kind run through the Unified Node Runtime under this environment's
   *  scope/ledger/capabilities; without it such nodes fail closed. */
  harness?: import("../harness/environment").WorkflowHarnessEnvironment
  /** MACP-M4: persistent interrupts. When present, human nodes with no
   *  answer pause the run (persisted record + waiting result + resume
   *  token) instead of blocking the process; `resumeAnswer` resumes a
   *  paused run by injecting the validated answer at the interrupted node. */
  interrupts?: {
    controller: import("../interrupts/resume-controller").ResumeController
    specDigest: string
    resumeAnswer?: { nodeId: string; answer: unknown; interruptId: string }
    onWaiting?: (record: import("../interrupts/types").WorkflowInterruptRecord, resumeToken: string) => void
    onResolved?: (interruptId: string) => void
  }
  onNodeFinished?: (result: import("../types").WorkflowNodeResult) => void
  /** R4: 资源账本 —— 节点启动前原子预留，不足时等待而非先启动
   *  （acceptance #11：RESOURCE_OVERCOMMIT: 0）。缺省 = 不启用。 */
  ledger?: ResourceLedger
  /** R4: 每节点资源估算（缺省按并发上限宽松估算）。 */
  resourceRequestFor?: (node: import("../types").WorkflowNodeSpec) => ResourceRequest
}

/** R4: 资源预留等待（原子预留成功才放行）。 */
async function awaitReservation(
  ledger: ResourceLedger,
  request: ResourceRequest,
  runId: string,
  cellId: string,
  agentId?: string,
): Promise<string> {
  for (;;) {
    const result = ledger.reserve(request, runId, cellId, agentId)
    if (result.ok) return result.reservation.reservationId
    await new Promise(r => setTimeout(r, 100))
  }
}

/** G7: node ids like "a1:w:patch" map to pool agent "a1". */
function agentOfNodeId(nodeId: string): string | null {
  const match = /^([^:]+):/.exec(nodeId)
  return match ? match[1]! : null
}

/** G5: a replayed (cache-hit) node — durationMs 0 + metadata.replayed. */
function replayResult(result: import("../types").WorkflowNodeResult): import("../types").WorkflowNodeResult {
  const output = result.output
  const meta: Record<string, unknown> =
    output && typeof output === "object" ? { ...((output as { metadata?: Record<string, unknown> }).metadata ?? {}) } : {}
  meta.replayed = true
  return {
    ...result,
    durationMs: 0,
    output:
      output && typeof output === "object"
        ? { ...(output as Record<string, unknown>), metadata: meta }
        : output,
  }
}

export async function runScheduler(
  spec: WorkflowSpec,
  registry: HandlerRegistry,
  options: SchedulerOptions = {},
): Promise<WorkflowRunResult> {
  const maxParallel = options.maxParallel ?? spec.maxParallel ?? 4
  if (maxParallel < 1) throw new Error("workflow: maxParallel must be >= 1")

  const cycle = detectCycle(spec)
  if (cycle) throw new Error(`workflow: cycle detected: ${cycle.join(" → ")}`)

  const mode = spec.mode ?? "readonly"
  const store = new ResultStore(spec.specId, options.checkpointDir)
  const cache = options.cache
  const queue = new ReadyQueue(spec, store)
  const cc = new ConcurrencyController()
  // MACP-M2: one harness runtime per workflow run (single scope + ledger).
  const harnessNodes = spec.nodes.filter(isHarnessNode)
  if (harnessNodes.length > 0 && !options.harness) {
    throw new Error(
      `workflow: spec declares ${harnessNodes.length} H11 node(s) but no harness environment — fail closed (MACP-M2)`,
    )
  }
  const harnessRuntime = options.harness
    ? createWorkflowHarnessRuntime(options.harness, `workflow:${spec.specId}`)
    : null
  // MACP-M3: worktrees created during this run, disposed when it finishes.
  const worktreeRegistry = createWorktreeRegistry()
  // G3 write protection covers both handler writes and H11 tool nodes
  // (write-class capabilities), so single-writer semantics apply uniformly.
  const writeNodeIds = new Set(
    spec.nodes
      .filter(n => {
        if (n.execution?.kind === "tool") {
          try {
            return options.harness?.capabilities.resolve(n.execution.capabilityId).descriptor.sideEffect === "write"
          } catch {
            return false // unknown capability — the ToolNode itself fails closed
          }
        }
        return registry.isWriteHandler(n.handler)
      })
      .map(n => n.id),
  )

  // G5: checkpoint restore — resumed nodes never re-execute, and their
  // results refill the cache for later runs (replay across runs).
  if (options.checkpointDir && store.restore(options.checkpointDir) && cache) {
    const handlerOf = new Map(spec.nodes.map(n => [n.id, n.handler]))
    for (const result of store.all()) {
      const handler = handlerOf.get(result.nodeId)
      if (!handler || registry.isWriteHandler(handler)) continue
      const node = spec.nodes.find(n => n.id === result.nodeId)
      if (!node) continue
      const replayed = replayResult(result)
      cache.put(cacheKeyFor(handler, node.input), replayed)
      store.put(replayed)
    }
  }

  const running = new Map<string, Promise<void>>()
  const finished = new Set<string>(spec.nodes.filter(n => store.has(n.id)).map(n => n.id))

  const launch = (node: import("../types").WorkflowNodeSpec, enforcement: import("../execution/workflow-execution-context").NodeEnforcement): void => {
    const isWrite = writeNodeIds.has(node.id)
    const isHarness = isHarnessNode(node)
    const promise = (async () => {
      if (isWrite && mode !== "read-write") {
        // G1 write protection: write handlers never run in read-only mode.
        const rejected: import("../types").WorkflowNodeResult = {
          nodeId: node.id,
          status: "failed",
          output: null,
          error: `workflow: write handler "${node.handler}" rejected in ${mode} mode`,
          startedAt: Date.now(),
          finishedAt: Date.now(),
          durationMs: 0,
        }
        store.put(rejected)
        return rejected
      }
      // G7: pool agents — cancelled agents fail fast, budgets are charged.
      const agentId = options.pool ? agentOfNodeId(node.id) : null
      if (agentId) {
        const agent = options.pool!.get(agentId)
        if (agent && (options.pool!.isCancelled(agentId) || agent.budget.exhausted())) {
          const cancelled: import("../types").WorkflowNodeResult = {
            nodeId: node.id,
            status: "failed",
            output: null,
            error: agent.budget.exhausted()
              ? `workflow: agent "${agentId}" budget exhausted (${JSON.stringify(agent.budget.stateSnapshot())})`
              : `workflow: agent "${agentId}" cancelled`,
            startedAt: Date.now(),
            finishedAt: Date.now(),
            durationMs: 0,
          }
          store.put(cancelled)
          return cancelled
        }
        const verdict = agent?.budget.chargeNode() ?? "ok"
        if (verdict !== "ok") {
          const budgetBlocked: import("../types").WorkflowNodeResult = {
            nodeId: node.id,
            status: "failed",
            output: null,
            error: `workflow: agent "${agentId}" budget verdict ${verdict}`,
            startedAt: Date.now(),
            finishedAt: Date.now(),
            durationMs: 0,
          }
          store.put(budgetBlocked)
          return budgetBlocked
        }
      }
      // G5: read-only cache hit → replay, never re-execute. H11 harness
      // nodes are never cached (they are not deterministic reducers).
      if (!isWrite && !isHarness && cache) {
        const hit = cache.get(cacheKeyFor(node.handler, node.input))
        if (hit) {
          const replayed = replayResult(hit.result)
          store.put(replayed)
          return replayed
        }
      }
      const lock = isWrite ? await cc.acquireWrite() : null
      // R4: 资源预留（不足时等待；释放与锁同 finally）。
      let reservationId: string | null = null
      if (options.ledger) {
        const request = options.resourceRequestFor
          ? options.resourceRequestFor(node)
          : { cpuQuota: 1, memoryBytes: 256 * 1024 * 1024, pids: 32, ioWeight: 0, networkSlots: 0, tempBytes: 512 * 1024 * 1024 }
        reservationId = await awaitReservation(options.ledger, request, spec.specId, node.id, agentId ?? undefined)
      }
      try {
        // MACP-M4: pass the interrupt runtime into the harness execution so
        // human nodes can pause (persisted record) or resume (answer).
        const interruptRuntime = options.interrupts
          ? {
              controller: options.interrupts.controller,
              specId: spec.specId,
              specDigest: options.interrupts.specDigest,
              resumeAnswer: options.interrupts.resumeAnswer,
              onWaiting: options.interrupts.onWaiting,
              onResolved: options.interrupts.onResolved,
            }
          : undefined
        const result = isHarness && harnessRuntime
          ? await executeHarnessNode(node, harnessRuntime, store, enforcement.projectRoot !== harnessRuntime.scope.projectRoot ? enforcement.projectRoot : undefined, interruptRuntime)
          : await executeNode(node, registry, store)
        // MACP-M3 task 8/9: actual written paths vs declared ownership —
        // only for assigned write nodes (no pool → legacy, unchanged).
        if (result.status === "done" && isWrite && enforcement.assignment) {
          const violation = enforceActualWrites(node, enforcement, result.output)
          if (violation) {
            const now = Date.now()
            const denied: import("../types").WorkflowNodeResult = {
              nodeId: node.id,
              status: "failed",
              output: null,
              error: `workflow: ownership_denied — ${violation}`,
              errorKind: "ownership_denied",
              startedAt: now,
              finishedAt: now,
              durationMs: 0,
            }
            store.put(denied)
            return denied
          }
        }
        if (result.status === "done") {
          if (isWrite) {
            // G5: a completed write invalidates all read results.
            cache?.invalidateAll()
          } else if (!isHarness) {
            cache?.put(cacheKeyFor(node.handler, node.input), result)
          }
        }
        return result
      } finally {
        lock?.release()
        if (reservationId) options.ledger?.release(reservationId)
      }
    })().then(result => {
      running.delete(node.id)
      if (result) {
        finished.add(node.id)
        queue.onDependencyDone(node.id)
        options.onNodeFinished?.(result)
      }
    }).catch(error => {
      running.delete(node.id)
      if (error instanceof WorkflowInterruptError) {
        // MACP-M4: the run pauses — no failed result, the waiting outcome
        // is produced by the main loop.
        pendingInterrupt.error = pendingInterrupt.error ?? error
      } else {
        throw error
      }
    })
    running.set(node.id, promise)
  }

  const pendingInterrupt: { error: WIE | null } = { error: null }

  while (true) {
    while (running.size < maxParallel && queue.hasReady && !pendingInterrupt.error) {
      const node = queue.next()
      if (!node) break
      if (store.has(node.id)) {
        queue.onDependencyDone(node.id)
        continue
      }
      // MACP-M1: conditional dependencies — every dependency must satisfy
      // its `when` condition; a finished-but-unsatisfied dependency blocks
      // this node (fail-closed, no deadlock: blocked is terminal).
      const readiness = evaluateReadiness(node, queue.depsOfNode(node.id), store.allAsMap())
      if (readiness.verdict === "blocked") {
        const blockedResult: import("../types").WorkflowNodeResult = {
          nodeId: node.id,
          status: "blocked",
          output: null,
          error: `workflow: node "${node.id}" blocked — dependency conditions unsatisfied: ${readiness.unsatisfied.map(u => `${u.nodeId}:${u.when}`).join(", ")}`,
          startedAt: Date.now(),
          finishedAt: Date.now(),
          durationMs: 0,
        }
        store.put(blockedResult)
        finished.add(node.id)
        queue.onDependencyDone(node.id)
        continue
      }
      // MACP-M3: participant assignment — pre-check ownership of declared
      // writes, prepare the agent worktree; denials fail the node closed.
      const enforcement = harnessRuntime
        ? enforceNodeAssignment(node, writeNodeIds.has(node.id), harnessRuntime, options.pool, worktreeRegistry)
        : { assignment: null as import("../agents/assignment").ParticipantAssignment | null, projectRoot: options.harness?.scope.projectRoot ?? "" }
      if (enforcement.deniedReason) {
        const denied = ownershipDeniedResult(node.id, enforcement.deniedReason)
        store.put(denied)
        finished.add(node.id)
        queue.onDependencyDone(node.id)
        continue
      }
      launch(node, enforcement)
    }
    if (finished.size === spec.nodes.length) break
    // MACP-M4: the run paused — stop launching, drain in-flight nodes, exit.
    if (pendingInterrupt.error && running.size === 0) break
    if (running.size === 0) {
      const blocked = spec.nodes.filter(n => !finished.has(n.id)).map(n => n.id)
      throw new Error(`workflow: deadlock — no ready node while ${blocked.length} pending (${blocked.join(", ")})`)
    }
    await Promise.race([...running.values()])
  }

  // MACP-M3 task 13: dispose every worktree this run created.
  worktreeRegistry.dispose()

  // MACP-M4: the run paused at a human node — the process is released with
  // a persisted record + resume token (PROCESS_BOUND_WAITING: 0).
  if (pendingInterrupt.error) {
    const record = pendingInterrupt.error.record
    const opened = options.interrupts
      ? {
          resumeToken: createResumeToken({
            specDigest: record.specDigest,
            expiresAt: record.expiresAt ?? Number.MAX_SAFE_INTEGER,
            interruptId: record.interruptId,
          }),
        }
      : { resumeToken: "" }
    return {
      specId: spec.specId,
      finishedAt: Date.now(),
      status: "waiting_interrupt",
      results: store.all(),
      interrupt: {
        interruptId: record.interruptId,
        resumeToken: opened.resumeToken,
        nodeId: record.nodeId,
        kind: record.kind,
        prompt: record.prompt,
        expiresAt: record.expiresAt,
      },
    }
  }

  const results = store.all()
  const base: WorkflowRunResult = {
    specId: spec.specId,
    finishedAt: Date.now(),
    status: "done",
    results,
  }

  const hasWriteNode = spec.nodes.some(n => registry.isWriteHandler(n.handler))
  if (hasWriteNode) {
    const evidence = aggregateEvidence(spec, results)
    base.evidence = evidence
    // A failed write node never completes, even if a verification node
    // reported passed (G3 completion gate + G4 convergence).
    const writeFailed = spec.nodes
      .filter(n => registry.isWriteHandler(n.handler))
      .some(n => results.find(r => r.nodeId === n.id)?.status === "failed")
    if (!evidence.some(e => e.passed) || writeFailed) {
      base.status = "blocked_no_evidence"
    }
  }
  // MACP-M4: a resumed run that completed resolves the interrupt record.
  if (options.interrupts?.resumeAnswer) {
    options.interrupts.onResolved?.(options.interrupts.resumeAnswer.interruptId)
  }
  // MACP-M5: unresolved merge conflicts block the run (task 12) — the merge
  // node reports them structurally instead of letting later agents win.
  const mergeNode = spec.nodes.find(n => n.handler === "reduce.merge_agents")
  if (mergeNode) {
    const mergeResult = results.find(r => r.nodeId === mergeNode.id)
    const output = mergeResult?.output as { metadata?: { conflicts?: unknown[]; valueConflicts?: unknown[] } } | null
    const meta = output?.metadata
    if (mergeResult?.status === "done" && ((meta?.conflicts?.length ?? 0) > 0 || (meta?.valueConflicts?.length ?? 0) > 0)) {
      base.status = "blocked_conflict"
    }
  }
  return base
}
