/** Capability Registry / Executor (H9) public surface. */

export { createCapabilityDescriptor, budgetKindsFor, TOOL_OUTPUT_SCHEMA } from "./descriptor"
export type { CapabilityDescriptorPartial } from "./descriptor"
export { createCapabilityRegistry } from "./registry"
export {
  FIRST_BATCH_TOOL_NAMES,
  classifyToolSideEffect,
  projectCapabilityDescriptor,
  registerToolCapabilities,
  sideEffectFromContract,
  toolCapabilityHandler,
} from "./tool-adapter"
