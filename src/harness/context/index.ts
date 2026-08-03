/** Context Pipeline (H10) public surface. */

export { runContextPipeline } from "./pipeline"
export { dedupeContributions } from "./dedupe"
export { allocateContextBudget } from "./budget-allocator"
export { contextSliceToMessages, stableMessageOf } from "./assemble"
