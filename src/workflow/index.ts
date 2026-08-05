/** Typed Execution Graph (G0): shadow projection over the run trace. */

export * from "./types"
export { WorkflowProjector, ProjectingRunTrace, wrapRunTrace, type TraceLike } from "./telemetry/workflow-trace"
export { serializeSnapshot, deserializeSnapshot, WORKFLOW_SNAPSHOT_SCHEMA } from "./telemetry/graph-snapshot"
export { stableHash, stableHashString, stableSerialize } from "./results/result-hash"
