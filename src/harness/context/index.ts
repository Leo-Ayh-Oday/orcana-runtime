/** Context Pipeline (H10) public surface. */

export { runContextPipeline } from "./pipeline"
export { computeCoverageGate, detectToolChainBreaks, verifyCoverageGate } from "./pipeline"
export { PIPELINE_ENTRYPOINT } from "./pipeline"
export type {
  BudgetMode,
  CoverageFact,
  CoverageGateResult,
  ContextPipelineOptionsExtra,
  PipelineMeta,
  RetentionCategory,
  RetentionEntry,
  RetentionManifest,
  RetentionReason,
  ToolChainBreak,
} from "./pipeline"
export { dedupeContributions } from "./dedupe"
export { allocateContextBudget, semanticTrimContent } from "./budget-allocator"
export type { AllocationResult, BudgetAllocatorOptions, TrimRecord } from "./budget-allocator"
export { contextSliceToMessages, stableMessageOf } from "./assemble"
export { createContextRequest } from "./request"
export { createDefaultContextProviders } from "./providers"
