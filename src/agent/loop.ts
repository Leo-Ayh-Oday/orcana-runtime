/** Agent Kernel orchestrator (ALK PR-L7).
 *
 *  loop.ts is the stage orchestration layer only:
 *    - outer generator close protocol (agentLoop → runAgentLoop);
 *    - run context assembly (kernel/context.ts);
 *    - prepare phase — clarification/research/context-map gates (kernel/prepare.ts);
 *    - the single main round loop (kernel/round.ts);
 *    - the single terminal switch + finalizeRun (kernel/finalize.ts);
 *    - the unified lifecycle: resource cleanup + Stop Hook dispatch in `finally`.
 *
 *  It executes no tools, parses no provider streams, and performs no
 *  verification/checkpoint/file-system work itself — those live in the
 *  kernel phases and the L3–L6 coordinators. All exits route through
 *  `finalizeRun()` and the `finally` block below.
 */

import type { StreamEvent } from "../provider/types"
import type { UsageStats, AgentOptions } from "./loop-types"
import { createAgentRunScope, runWithAgentRunScope } from "./run/scope"
import type { AgentRunLifecycleState } from "./run/types"
import { WorkspaceAuthorityRegistry } from "../runtime/linux/workspace/workspace-authority"
import type { TrustedExecutionAuthority } from "../runtime/linux/contracts"
import { randomUUID } from "node:crypto"

/** R2 PR-9（§5.8）：主工作区注册 + Run 级 Trusted Execution Authority。
 *  同一物理 projectRoot → 稳定 workspaceId（同锁身份）。 */
function buildRunAuthority(projectRoot: string, runId: string): TrustedExecutionAuthority {
  const registry = new WorkspaceAuthorityRegistry()
  const workspace = registry.registerMainWorkspace({
    projectId: runId,
    hostRoot: projectRoot,
    access: "readwrite",
  })
  return {
    identity: {
      runId,
      nodeRunId: `${runId}:n1`,
      attempt: 1,
    },
    workspace,
  }
}
import { buildRunContext } from "./kernel/context"
import { prepareRun } from "./kernel/prepare"
import { runRound } from "./kernel/round"
import { finalizeRun } from "./kernel/finalize"
import { drainPhase } from "./kernel/effects"
import type { LoopDecision } from "./kernel/types"
import { setRuntimeContextBudgetMode } from "./runtime-context"
import { bindRunRetryLedgerToContext, getRunRetryLedger, getRunRetryCoordinator, setExecutionIdentity, setRunRetryCoordinator } from "../runtime/execution-context"
import { RetryCoordinator, deriveMaxPhysicalProviderRequests } from "../runtime/retry/coordinator"
import { resetRippleProgram, setCascadeFiles } from "../ripple/engine"
import { clearActivePatchContext, clearTransactionRegistry } from "./patch-transaction"
import { setShellSandbox } from "../tools/shell"

export type { UsageStats, AgentOptions }

export async function* agentLoop(
  prompt: string,
  options: AgentOptions,
): AsyncGenerator<StreamEvent, LoopDecision> {
  // R2 PR-9（§5.8）：主工作区注册 + Trusted Execution Authority 构建。
  // 身份/工作区是 Linux 工具执行的唯一来源（INV-A/INV-B）；模型不可覆盖。
  const projectRoot = options.projectRoot ?? process.cwd()
  const runId = options.sessionId ?? `run-${randomUUID().slice(0, 8)}`
  const authority: TrustedExecutionAuthority = buildRunAuthority(projectRoot, runId)
  const scope = createAgentRunScope({
    tools: options.tools,
    planStore: options.planStore,
    id: options.sessionId ? `agent-run:${options.sessionId}` : undefined,
    authority,
  })
  // PR-6：执行身份注入（兼容层；权威身份以 authority 为准）。
  setExecutionIdentity({
    runId,
    sessionId: options.sessionId,
  })
  // PR-GATE-06：harness 传入的 Run 级 RetryLedger 绑定进本 scope 的 ALS
  // context —— 与 harness 侧（tool-node/capability）共享同一重试预算。
  if (options.retryLedger) {
    bindRunRetryLedgerToContext(scope.runtimeContext, options.retryLedger)
  }
  // IC04 §29/§30: coordinator 创建/绑定在 runAgentLoop 内完成（ALS 内，
  // 与 harness 共享同一 ledger）。见 runAgentLoop 头部。
  const runOptions: AgentOptions = {
    ...options,
    tools: scope.toolRegistry.tools,
    planStore: scope.planStore,
  }
  const iterator = runAgentLoop(prompt, runOptions)
  let completed = false

  try {
    while (true) {
      const step = await runWithAgentRunScope(scope, () => iterator.next())
      if (step.done) {
        completed = true
        // H2: the kernel's final LoopDecision is the generator return value —
        // the harness maps it to a RunOutcome (no exit is unclassifiable).
        return step.value
      }
      yield step.value
    }
  } finally {
    if (!completed) {
      await runWithAgentRunScope(scope, () => iterator.return(undefined as never))
    }
  }
}

async function* runAgentLoop(
  prompt: string,
  options: AgentOptions,
): AsyncGenerator<StreamEvent, LoopDecision> {
  const { hooks } = options
  const lifecycle: AgentRunLifecycleState = {
    startedAt: Date.now(),
    finalRound: 0,
    stopReason: "aborted",
    stopHookDispatched: false,
    reachedRoundBudget: false,
  }
  const dispatchStopHook = async (reason: typeof lifecycle.stopReason, totalRounds = lifecycle.finalRound) => {
    if (!hooks || lifecycle.stopHookDispatched) return
    lifecycle.stopHookDispatched = true
    await hooks.dispatchStop({ reason, totalRounds, sessionDurationMs: Date.now() - lifecycle.startedAt })
  }
  // Abort-at-start: no run state exists yet, so this is the one pre-state
  // exit that dispatches the Stop Hook directly (same as pre-L7).
  if (options.abortSignal?.aborted) {
    await dispatchStopHook("aborted", 0)
    return { kind: "return", reason: "aborted" }
  }

  // IC04 §29/§30：整个 run 只有一个 RetryCoordinator（retry decision
  // authority）。caller/harness 已注入 → 复用实例；否则自建（与
  // getRunRetryLedger 同一账本，§24 derived physical cap）。
  if (options.retryCoordinator) {
    setRunRetryCoordinator(options.retryCoordinator)
  } else {
    const physicalCap = options.maxPhysicalProviderRequests
      ?? deriveMaxPhysicalProviderRequests(options.maxRounds ?? 50)
    setRunRetryCoordinator(new RetryCoordinator({
      ledger: getRunRetryLedger(),
      maxPhysicalProviderRequests: physicalCap,
    }))
  }

  let ctx: Awaited<ReturnType<typeof buildRunContext>>["ctx"] = null
  try {
    const built = await buildRunContext(prompt, options, lifecycle)
    ctx = built.ctx
    let decision: LoopDecision = built.earlyStop ?? { kind: "continue" }
    if (decision.kind === "continue") {
      decision = yield* drainPhase(prepareRun(ctx!), ctx!)
    }
    // The single main round loop. IC04 §8: 是否允许开始下一次 main
    // Provider round 只由 LoopSupervisor.beforeRound 判定（maxRounds 数据
    // 仍保留在 Context，其他 Gate 可读，但 liveness 判定唯一归 supervisor）。
    if (decision.kind === "continue") {
      let round = 0
      while (ctx!.loopSupervisor.beforeRound(round, ctx!.maxRounds) === "START") {
        ctx!.lifecycle.finalRound = round
        const outcome = yield* drainPhase(runRound(round, ctx!), ctx!)
        if (outcome.kind === "continue") {
          round += 1
          continue
        }
        decision = outcome
        break
      }
      if (decision.kind === "continue") {
        decision = { kind: "break", reason: "round_budget" }
      }
    }
    // The single terminal switch: every exit routes through finalizeRun
    // (ctx may be null only for the pre-state prompt-blocked exit).
    yield* finalizeRun(ctx, decision, lifecycle)
    return decision
  } catch (error) {
    lifecycle.stopReason = "error"
    throw error
  } finally {
    try {
      // Unified lifecycle: resource cleanup before the Stop Hook.
      setRuntimeContextBudgetMode("normal")
      setCascadeFiles(new Set())
      resetRippleProgram()
      clearActivePatchContext()
      clearTransactionRegistry()
      setShellSandbox(null)
      ctx?.sandbox.dispose()
    } finally {
      await dispatchStopHook(lifecycle.stopReason)
    }
  }
}
