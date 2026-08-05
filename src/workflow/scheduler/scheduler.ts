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

export interface SchedulerOptions {
  maxParallel?: number
  checkpointDir?: string
  onNodeFinished?: (result: import("../types").WorkflowNodeResult) => void
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
  const queue = new ReadyQueue(spec, store)
  const cc = new ConcurrencyController()

  const running = new Map<string, Promise<void>>()
  const finished = new Set<string>(spec.nodes.filter(n => store.has(n.id)).map(n => n.id))

  const launch = (node: import("../types").WorkflowNodeSpec): void => {
    const isWrite = registry.isWriteHandler(node.handler)
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
      const lock = isWrite ? await cc.acquireWrite() : null
      try {
        return await executeNode(node, registry, store)
      } finally {
        lock?.release()
      }
    })().then(result => {
      running.delete(node.id)
      finished.add(node.id)
      queue.onDependencyDone(node.id)
      options.onNodeFinished?.(result)
    })
    running.set(node.id, promise)
  }

  while (true) {
    while (running.size < maxParallel && queue.hasReady) {
      const node = queue.next()
      if (!node) break
      if (store.has(node.id)) {
        queue.onDependencyDone(node.id)
        continue
      }
      launch(node)
    }
    if (finished.size === spec.nodes.length) break
    if (running.size === 0) {
      const blocked = spec.nodes.filter(n => !finished.has(n.id)).map(n => n.id)
      throw new Error(`workflow: deadlock — no ready node while ${blocked.length} pending (${blocked.join(", ")})`)
    }
    await Promise.race([...running.values()])
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
    if (!evidence.some(e => e.passed)) {
      base.status = "blocked_no_evidence"
    }
  }
  return base
}
