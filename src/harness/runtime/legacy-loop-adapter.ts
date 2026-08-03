/** LegacyLoopAdapter (H1): bridges AgentHarness → agentLoop.
 *
 *  Responsibilities (plan §9.2):
 *    - build AgentOptions from AgentRunInput + injected runtime deps;
 *    - translate the legacy StreamEvent stream into typed HarnessEvents
 *      (EventEnvelope with run-unique increasing sequence);
 *    - NOT persist run terminal state (H2 maps LoopDecision → RunOutcome).
 *
 *  Runtime-stable deps (provider, tools, hooks, …) are injected at harness
 *  construction; per-invocation dynamic options (conversation history, plan
 *  approval state, trace, …) travel through AgentRunInput.metadata under the
 *  documented LEGACY_* keys. This is an H1 transition mechanism — H4/H7
 *  formalize budget and interrupts.
 */

import { randomUUID } from "node:crypto"
import { agentLoop } from "../../agent/loop"
import type { AgentOptions } from "../../agent/loop-types"
import type { LoopDecision } from "../../agent/kernel/types"
import type { HookSystem } from "../../hooks"
import type { StagedContextManager } from "../../context/staged"
import type { ThinkingStore } from "../../memory/thinking-store"
import type { KnowledgeBase } from "../../memory/knowledge"
import type { ModelRouter } from "../../provider/router"
import type { AgentRunTrace } from "../../agent/run-trace"
import type { SessionCheckpoint } from "../../session/checkpoint"
import type { LLMProvider, StreamEvent } from "../../provider/types"
import type { ToolDescriptor } from "../../tools/registry"
import { HARNESS_EVENT_SCHEMA_VERSION, HARNESS_EVENT_TYPES } from "../contracts/events"
import type { HarnessEvent } from "../contracts/events"
import type { AgentRun, AgentRunInput } from "../contracts/run"
import type { CapabilityRegistry } from "../contracts/capability"
import type { SideEffect } from "../contracts/capability"
import { classifyToolSideEffect } from "../capabilities/tool-adapter"
import { putPlanArtifact } from "../artifacts/evidence-adapter"

export interface LegacyLoopAdapterDeps {
  provider: LLMProvider
  tools: ToolDescriptor[]
  /** Optional model override; otherwise selected via modelRouter. */
  model?: string
  modelRouter?: ModelRouter
  hooks?: HookSystem
  stagedContext?: StagedContextManager
  thinkingStore?: ThinkingStore
  knowledgeBase?: KnowledgeBase
  gateTelemetryFile?: string
  contextMapPolicy?: "off" | "auto" | "always"
  flashTriagePolicy?: "off" | "auto" | "always"
  /** H9: capability registry (first migration batch) injected into the kernel. */
  capabilityRegistry?: CapabilityRegistry
}

// ── Metadata transport keys (H1 transition) ──

export const LEGACY_CONVERSATION_HISTORY = "legacy.conversationHistory" as const
export const LEGACY_THINK_EFFORT = "legacy.thinkEffort" as const
export const LEGACY_STABLE_MEMORY_CONTEXT = "legacy.stableMemoryContext" as const
export const LEGACY_AUTO_APPROVE_PLAN = "legacy.autoApprovePlan" as const
export const LEGACY_AUTO_FINISH_ON_VERIFIED_WRITE = "legacy.autoFinishOnVerifiedWrite" as const
export const LEGACY_RUN_TRACE = "legacy.runTrace" as const
export const LEGACY_INITIAL_PLAN_STATE = "legacy.initialPlanState" as const
export const LEGACY_PLAN_TEXT = "legacy.planText" as const
export const LEGACY_RESUME_FROM_CHECKPOINT = "legacy.resumeFromCheckpoint" as const

export interface LegacyLoopAdapter {
  /** Yields bridged HarnessEvents; the generator return value is the
   *  legacy kernel's final LoopDecision (H2 — no exit is unclassifiable). */
  execute(run: AgentRun, input: AgentRunInput, abortSignal?: AbortSignal): AsyncGenerator<HarnessEvent, LoopDecision>
}

function readMetadata<T>(input: AgentRunInput, key: string): T | undefined {
  const value = input.metadata?.[key]
  return value === undefined ? undefined : (value as T)
}

/** Extract the plan text from a plan_ready payload (H9 plan artifact input).
 *  Accepts a raw string, or objects carrying planText/text, falling back to a
 *  JSON snapshot of opaque plan shapes. */
export function planTextFromPayload(plan: unknown): string {
  if (typeof plan === "string") return plan
  if (plan !== null && typeof plan === "object") {
    const shaped = plan as { planText?: unknown; text?: unknown }
    const direct = shaped.planText ?? shaped.text
    if (typeof direct === "string") return direct
    return JSON.stringify(plan)
  }
  return String(plan ?? "")
}

/** Build AgentOptions for agentLoop from run input + deps + metadata. */
export function buildLoopOptions(
  run: AgentRun,
  input: AgentRunInput,
  deps: LegacyLoopAdapterDeps,
  abortSignal?: AbortSignal,
): AgentOptions {
  const tools = input.tools?.length
    ? deps.tools.filter(tool => input.tools!.some(sel => sel.name === tool.defn.name))
    : deps.tools
  return {
    provider: deps.provider,
    model: deps.model ?? deps.modelRouter?.selectForPurpose("agent_main") ?? "deepseek-v4-flash",
    tools,
    abortSignal,
    sessionId: run.sessionId,
    // H3: single ownership — the harness's run-scoped planStore/sandbox are
    // the same instances the legacy kernel operates on.
    planStore: run.scope.planStore,
    sandbox: run.scope.sandbox,
    // H8: run-scoped artifact store (verification binds artifacts to it).
    artifactStore: run.scope.artifactStore,
    runId: run.runId,
    // H9: capability registry — the loop's tool executions route through the
    // CapabilityExecutor with this registry (shared with the future Node Runtime).
    capabilityRegistry: deps.capabilityRegistry,
    hooks: deps.hooks,
    stagedContext: deps.stagedContext,
    thinkingStore: deps.thinkingStore,
    knowledgeBase: deps.knowledgeBase,
    modelRouter: deps.modelRouter,
    gateTelemetryFile: deps.gateTelemetryFile,
    contextMapPolicy: deps.contextMapPolicy,
    flashTriagePolicy: deps.flashTriagePolicy,
    maxRounds: input.maxRounds,
    conversationHistory: readMetadata(input, LEGACY_CONVERSATION_HISTORY),
    thinkEffort: readMetadata(input, LEGACY_THINK_EFFORT),
    stableMemoryContext: readMetadata(input, LEGACY_STABLE_MEMORY_CONTEXT),
    autoApprovePlan: readMetadata(input, LEGACY_AUTO_APPROVE_PLAN),
    autoFinishOnVerifiedWrite: readMetadata(input, LEGACY_AUTO_FINISH_ON_VERIFIED_WRITE),
    runTrace: readMetadata(input, LEGACY_RUN_TRACE),
    initialPlanState: readMetadata(input, LEGACY_INITIAL_PLAN_STATE),
    planText: readMetadata(input, LEGACY_PLAN_TEXT),
    resumeFromCheckpoint: readMetadata(input, LEGACY_RESUME_FROM_CHECKPOINT),
  }
}

export interface LegacyLoopAdapterInput {
  deps: LegacyLoopAdapterDeps
}

export function createLegacyLoopAdapter(input: LegacyLoopAdapterInput): LegacyLoopAdapter {
  const { deps } = input
  return {
    execute(run, runInput, abortSignal) {
      return executeLoop(run, runInput, deps, abortSignal)
    },
  }
}

async function* executeLoop(
  run: AgentRun,
  runInput: AgentRunInput,
  deps: LegacyLoopAdapterDeps,
  abortSignal?: AbortSignal,
): AsyncGenerator<HarnessEvent, LoopDecision> {
  const options = buildLoopOptions(run, runInput, deps, abortSignal)
  // H2: bridge events share the run's eventSequence with lifecycle events,
  // so the whole stream is one continuous, ordered sequence.
  const emit = <T>(type: string, payload: T): HarnessEvent => {
    run.eventSequence++
    return {
      schemaVersion: HARNESS_EVENT_SCHEMA_VERSION,
      eventId: randomUUID(),
      sequence: run.eventSequence,
      runId: run.runId,
      sessionId: run.sessionId,
      type,
      timestamp: new Date().toISOString(),
      payload,
    } as HarnessEvent
  }

  const iterator = agentLoop(runInput.prompt, options)
  let closed = false
  try {
    while (true) {
      const step = await iterator.next()
      if (step.done) {
        closed = true
        // H2: the kernel's final LoopDecision rides the generator return value.
        return step.value as LoopDecision
      }
      // H9: plan activation is a run-flow fact — record it as a plan artifact
      // at the bridge (the executor chain never sees plan_ready).
      if (step.value.type === "plan_ready" && run.scope.artifactStore) {
        const planText = planTextFromPayload(step.value.data)
        if (planText) {
          try {
            await putPlanArtifact({
              store: run.scope.artifactStore,
              runId: run.runId,
              planText,
              producedBy: "planning",
            })
          } catch {
            // Best-effort: artifact recording never breaks the run.
          }
        }
      }
      const translated = translateStreamEvent(step.value, emit, (name) => classifyToolSideEffect(name, deps.tools))
      if (translated) yield translated
    }
  } finally {
    // Close protocol: consumer close (cancel) propagates into the legacy loop
    // so its provider/tool iterators are still cleaned up.
    if (!closed) {
      try {
        await iterator.return(undefined as never)
      } catch {
        // Best-effort close.
      }
    }
  }
}

function translateStreamEvent(
  event: StreamEvent,
  emit: <T>(type: string, payload: T) => HarnessEvent,
  classifySideEffect?: (name: string) => SideEffect,
): HarnessEvent | null {
  switch (event.type) {
    case "text":
      return emit(HARNESS_EVENT_TYPES.textEmitted, { text: String(event.data ?? "") })
    case "status":
      return emit(HARNESS_EVENT_TYPES.displayChanged, { display: { kind: "status", data: event.data } })
    case "task_progress":
      return emit(HARNESS_EVENT_TYPES.displayChanged, { display: { kind: "task_progress", data: event.data } })
    case "thinking_blocks":
      return emit(HARNESS_EVENT_TYPES.displayChanged, { display: { kind: "thinking_blocks", data: event.data } })
    case "confirm":
      return emit(HARNESS_EVENT_TYPES.displayChanged, { display: { kind: "confirm", data: event.data } })
    case "user_question":
      return emit(HARNESS_EVENT_TYPES.displayChanged, { display: { kind: "user_question", data: event.data } })
    case "tool_call": {
      const call = event.data as { id?: string; name?: string; input?: unknown } | undefined
      const name = String(call?.name ?? "")
      return emit(HARNESS_EVENT_TYPES.toolCallRequested, {
        toolCall: {
          id: String(call?.id ?? ""),
          name,
          input: call?.input,
          // H9: capability classification rides the bridged event so the
          // harness-side BudgetGuard can enforce write/external_action class
          // limits (same descriptor source as the executor — no double count).
          sideEffect: classifySideEffect?.(name),
        },
      })
    }
    case "tool_result": {
      const result = event.data as { name?: string; success?: boolean; content?: unknown } | undefined
      return emit(HARNESS_EVENT_TYPES.toolCallCompleted, {
        toolName: String(result?.name ?? ""),
        success: Boolean(result?.success),
        content: typeof result?.content === "string" ? result.content : JSON.stringify(result?.content ?? ""),
      })
    }
    case "token_usage":
      return emit(HARNESS_EVENT_TYPES.modelUsage, { usage: event.data })
    case "error":
      return emit(HARNESS_EVENT_TYPES.errorRaised, { error: String(event.data ?? "") })
    case "plan_ready":
      // Opaque in H1 — the legacy plan artifact shape; CLI reads the fields
      // it renders today. H7 formalizes the plan-approval interrupt schema.
      return emit(HARNESS_EVENT_TYPES.planReady, { planReady: { plan: event.data } })
    case "clarification_ready":
      return emit(HARNESS_EVENT_TYPES.clarificationReady, { clarification: { questions: event.data } })
    case "done":
      // Legacy "done" marker has no UI payload; the flow ends when the
      // generator completes. Dropped by design.
      return null
  }
}
