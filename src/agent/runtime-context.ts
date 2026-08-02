import { createRuntimeContextKey, getRuntimeContextValue, setRuntimeContextValue } from "../runtime/execution-context"

export {
  createRuntimeExecutionContext,
  getRuntimeContextValue,
  runWithRuntimeExecutionContext,
  setRuntimeContextValue,
} from "../runtime/execution-context"
export type { RuntimeExecutionContext } from "../runtime/execution-context"

export type RuntimeContextBudgetMode = "normal" | "degraded" | "block"

const CONTEXT_BUDGET_MODE = createRuntimeContextKey<RuntimeContextBudgetMode>(
  "runtime-context-budget-mode",
  () => "normal",
)

/** @deprecated Compatibility adapter; prefer AgentRunScope-owned budget state. */
export function setRuntimeContextBudgetMode(mode: RuntimeContextBudgetMode) {
  setRuntimeContextValue(CONTEXT_BUDGET_MODE, mode)
}

/** @deprecated Compatibility projection; prefer AgentRunScope-owned budget state. */
export function getRuntimeContextBudgetMode(): RuntimeContextBudgetMode {
  return getRuntimeContextValue(CONTEXT_BUDGET_MODE)
}
