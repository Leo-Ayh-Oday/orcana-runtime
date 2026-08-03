/**
 * H0: Harness public surface.
 *
 * Pure contracts — no runtime behavior. Production wiring (AgentHarness facade,
 * LegacyLoopAdapter, lifecycle machine, run scope) lands in H1+.
 */

export type { AgentHarness } from "./contracts/harness"
export type { AgentSession, CreateSessionInput } from "./contracts/session"
export type {
  AgentRun,
  AgentRunInput,
  AgentRunScope,
  RunStatus,
} from "./contracts/run"
export { TERMINAL_RUN_STATUSES, isTerminalRunStatus } from "./contracts/run"
export type {
  ModeStore,
  PatchContextStore,
  RippleSession,
  RunCancellation,
  TraceWriter,
} from "./contracts/scope"
export type { RunOutcome, RunOutcomeKind, RunBlocker, RunFailure } from "./contracts/outcome"
export { outcomeKind } from "./contracts/outcome"
export type { HarnessEvent, HarnessEventType, HarnessDisplayKind } from "./contracts/events"
export { HARNESS_EVENT_SCHEMA_VERSION, HARNESS_EVENT_TYPES } from "./contracts/events"
export type { EventEnvelope } from "./contracts/events"
export type { InterruptKind, InterruptStatus, HarnessInterrupt, InterruptResponse } from "./contracts/interrupt"
export type { HarnessArtifact, HarnessArtifactKind, HarnessArtifactStatus, ArtifactStore } from "./contracts/artifact"
export type {
  RunBudget,
  BudgetUsage,
  BudgetRequest,
  BudgetReservation,
  BudgetLedger,
  BudgetExhaustionReason,
} from "./contracts/budget"
export type {
  CapabilityDescriptor,
  CapabilityHandler,
  CapabilityKind,
  CapabilityRegistry,
  CapabilityFilter,
  RegisteredCapability,
  SideEffect,
} from "./contracts/capability"
export type { JsonSchema, JsonSchemaType } from "./contracts/schema"
export type {
  ContextLayer,
  ContextContribution,
  ContextProvider,
  ContextRequest,
  ContextSlice,
  ContextBudgetPolicy,
  ContextTrimInfo,
  ContextPipelineOptions,
} from "./contracts/context"
export { LAYER_ORDER } from "./contracts/context"
export type {
  NodeKind,
  NodeRunStatus,
  NodeUsage,
  NodeDiagnostic,
  NodeRunError,
  NodeResult,
  HarnessNode,
  NodeExecutionContext,
  NodeEvent,
  AgentNodeInput,
  AgentNodeOutput,
  ToolNodeInput,
  VerificationNodeInput,
  HumanNodeInput,
} from "./contracts/nodes"
export { NODE_EVENT_TYPES } from "./contracts/nodes"
export {
  createNodeExecutionContext,
  createDefaultNodePolicyContext,
  createMinimalContextSlice,
  createNodeRunId,
} from "./nodes/context"
export { runNode, runNodeToResult } from "./nodes/run"
export { createFunctionNode } from "./nodes/function-node"
export type { RunSnapshot } from "./contracts/snapshot"
export {
  LEGAL_TRANSITIONS,
  canTransition,
  assertTransition,
} from "./contracts/lifecycle"
export {
  HarnessError,
  SessionNotFoundError,
  RunNotFoundError,
  InvalidStateTransitionError,
  InvalidInterruptResponseError,
  type HarnessErrorKind,
} from "./contracts/errors"
