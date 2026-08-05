/** Capability Registry / Executor (H9) + Tool Runtime 2.0 contracts (RT-1). */

export { createCapabilityDescriptor, budgetKindsFor, TOOL_OUTPUT_SCHEMA } from "./descriptor"
export type { CapabilityDescriptorPartial } from "./descriptor"
export { createCapabilityRegistry } from "./registry"
export { executeCapability } from "./executor"
export type { CapabilityArtifactTracker, CapabilityExecuteInput, CapabilityExecutionResult } from "./executor"
export { buildNodePolicyInput } from "./policy-adapter"
export type { NodePolicyContext } from "./policy-adapter"
export {
  FIRST_BATCH_TOOL_NAMES,
  classifyToolSideEffect,
  projectCapabilityDescriptor,
  registerToolCapabilities,
  sideEffectFromContract,
  toolCapabilityHandler,
} from "./tool-adapter"
// RT-1: Tool Runtime 2.0 contracts.
export { TOOL_ERROR_CODES, ToolError, toolError } from "./errors"
export type { ToolErrorCode, ToolErrorCategory, ToolErrorInfo } from "./errors"
export { toolResult, resultHelpers } from "./result"
export type {
  ArtifactReference,
  Diagnostic,
  EvidenceReference,
  ToolExecutionMetrics,
  ToolExecutionResult,
  ToolExecutionStatus,
} from "./result"
export { NO_RETRY, retryDelayMs, shouldRetry } from "./retry"
export type { RetryPolicy } from "./retry"
export { buildExecutionContext, contextFromRunScope, systemClock } from "./execution-context"
export type { ApprovalContext, Clock, ToolExecutionContext } from "./execution-context"
export { validateJsonSchema } from "./schema-validator"
// RT-2: capability mode flag.
export { CAPABILITY_MODE_DEFAULT, getCapabilityMode, isEnabledMode, isShadowMode } from "./flags"
export type { CapabilityMode } from "./flags"
