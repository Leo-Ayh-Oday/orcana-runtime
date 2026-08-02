import {
  createRuntimeFileStateContext,
  runWithRuntimeFileStateContext,
  type RuntimeFileStateContext,
} from "../../file-state"
import type { ToolDescriptor } from "../../tools/registry"
import {
  createRuntimeExecutionContext,
  runWithRuntimeExecutionContext,
  type RuntimeExecutionContext,
} from "../../runtime/execution-context"
import { createPlanStore, type PlanStore } from "./plan-store"
import {
  createAgentRunToolRegistry,
  type AgentRunToolRegistry,
} from "./tool-registry"
import { createTodoStore, type TodoStore } from "./todo-store"

export interface AgentRunScope {
  readonly id: string
  readonly planStore: PlanStore
  readonly todoStore: TodoStore
  readonly toolRegistry: AgentRunToolRegistry
  readonly runtimeContext: RuntimeExecutionContext
  readonly fileState: RuntimeFileStateContext
}

export interface CreateAgentRunScopeInput {
  tools: readonly ToolDescriptor[]
  planStore?: PlanStore
  todoStore?: TodoStore
  id?: string
}

export function createAgentRunScope(input: CreateAgentRunScopeInput): AgentRunScope {
  const planStore = input.planStore ?? createPlanStore()
  const todoStore = input.todoStore ?? createTodoStore()
  const toolRegistry = createAgentRunToolRegistry(input.tools, planStore, todoStore)
  const runtimeContext = createRuntimeExecutionContext({
    id: input.id,
    planStore,
    toolRegistry,
  })

  return {
    id: runtimeContext.id,
    planStore,
    todoStore,
    toolRegistry,
    runtimeContext,
    fileState: createRuntimeFileStateContext(),
  }
}

export function runWithAgentRunScope<T>(
  scope: AgentRunScope,
  callback: () => T,
): T {
  return runWithRuntimeExecutionContext(
    scope.runtimeContext,
    () => runWithRuntimeFileStateContext(scope.fileState, callback),
  )
}
