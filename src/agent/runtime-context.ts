import { getRuntimeContextValue, setRuntimeContextValue } from "../runtime/execution-context"

export {
  createRuntimeExecutionContext,
  getRuntimeContextValue,
  runWithRuntimeExecutionContext,
  setRuntimeContextValue,
} from "../runtime/execution-context"
export type { RuntimeExecutionContext } from "../runtime/execution-context"

export type RuntimeContextBudgetMode = "normal" | "degraded" | "block"

const CONTEXT_BUDGET_MODE = Symbol("runtime-context-budget-mode")

export function setRuntimeContextBudgetMode(mode: RuntimeContextBudgetMode) {
  setRuntimeContextValue(CONTEXT_BUDGET_MODE, mode)
}

export function getRuntimeContextBudgetMode(): RuntimeContextBudgetMode {
  return getRuntimeContextValue(CONTEXT_BUDGET_MODE, "normal")
}
