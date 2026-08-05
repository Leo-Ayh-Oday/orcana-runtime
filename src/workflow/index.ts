/** Typed Execution Graph (G0–G1): shadow projection + read-only DAG scheduler. */

export * from "./types"
export { WorkflowProjector, ProjectingRunTrace, wrapRunTrace, type TraceLike } from "./telemetry/workflow-trace"
export { serializeSnapshot, deserializeSnapshot, WORKFLOW_SNAPSHOT_SCHEMA } from "./telemetry/graph-snapshot"
export { stableHash, stableHashString, stableSerialize } from "./results/result-hash"
export { ResultStore } from "./results/result-store"
export { buildTopology, detectCycle, topologicalOrder } from "./results/edge-store"
export { HandlerRegistry } from "./execution/handler-registry"
export { runReadonlyTool } from "./execution/tool-executor"
export { ReadyQueue } from "./scheduler/ready-queue"
export { runScheduler, type SchedulerOptions } from "./scheduler/scheduler"
export { compileFromSnapshot } from "./compiler/snapshot-compiler"
export { buildReadonlyRegistry, buildReadWriteRegistry } from "./registry"
export { dedupeValues, mergeDiagnostics } from "./reducers/dedupe"
export { aggregateEvidence, type EvidenceEntry } from "./reducers/aggregate-evidence"
export { ConcurrencyController } from "./scheduler/concurrency-controller"
export { runWriteNode, WRITE_HANDLERS } from "./execution/transaction-executor"
export { buildNarrowFix, buildTestRepair, type WriteTemplateInput } from "./templates/write-templates"
export { validateSpec, assertValidSpec, type ValidationContext, type ValidationReport } from "./validation"
export { compileMasterPlan, type PlanLike, type PlanLikeNode } from "./compiler/master-plan-adapter"
export { buildTemplate, TEMPLATES, type Template, type TemplateInput } from "./templates/registry"
export { normalizeSpec } from "./compiler/graph-normalizer"
export { projectResultsToPlan, type PlanStatusProjection } from "./projection/plan-projection"
export {
  classifyError,
  fingerprintFailure,
  ERROR_CATEGORIES,
  type ErrorCategory,
} from "./convergence/failure-signature"
export { RepairLoop, type RepairLoopOptions, type ConvergenceReport, type RepairAttempt, type RepairOutcome } from "./convergence/repair-loop"
export { ResultCache, cacheKeyFor, type CacheEntry } from "./results/result-cache"
export { saveResultCache, loadResultCache } from "./persistence/result-cache-store"
export { buildContextSlice, sliceDependencyIds, type ContextSlice, type DependencySlice } from "./context/context-slice"
export {
  parseDynamicSpec,
  payloadToSpec,
  DYNAMIC_NODE_TYPES,
  type DynamicGraphPayload,
  type DynamicNodePayload,
  type DynamicNodeType,
} from "./dynamic/dynamic-schema"
export { compileDynamicSpec, DEFAULT_NODE_TYPES, type DynamicCompilerOptions, type DynamicCompileResult, type DynamicIssue } from "./dynamic/dynamic-compiler"
export { PermissionGate, type GateDecision, type GateResult } from "./dynamic/permission-gate"
