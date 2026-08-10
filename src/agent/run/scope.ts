import {
  createRuntimeFileStateContext,
  runWithRuntimeFileStateContext,
  type RuntimeFileStateContext,
} from "../../file-state"
import type { ToolDescriptor } from "../../tools/registry"
import {
  createRuntimeExecutionContext,
  runWithRuntimeExecutionContext,
  setExecutionAuthority,
  setWorkspaceIoAuthority,
  type RuntimeExecutionContext,
} from "../../runtime/execution-context"
import type { TrustedExecutionAuthority } from "../../runtime/linux/contracts"
import {
  createWorkspaceIoAuthority,
  type WorkspaceIoAuthority,
} from "../../runtime/io/workspace-io-authority"
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
  /** R2 PR-9（§5.8）：本 Run 的可信执行权威（Linux 工具执行的身份/工作区
   *  唯一来源；由 agentLoop 在入口构建并注入 ALS）。 */
  readonly authority?: TrustedExecutionAuthority
  /** IC01：本 Run 的统一工作区 I/O 权威 —— 读取根以
   *  TrustedExecutionAuthority.workspace.hostRoot 为权威（production 派生）。 */
  readonly workspaceIo?: WorkspaceIoAuthority
}

export interface CreateAgentRunScopeInput {
  tools: readonly ToolDescriptor[]
  planStore?: PlanStore
  todoStore?: TodoStore
  id?: string
  /** R2 PR-9：Trusted Execution Authority（agentLoop 入口生成）。 */
  authority?: TrustedExecutionAuthority
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
    authority: input.authority,
    // IC01: production 读取根 = authority.workspace.hostRoot（realpath 物理根）。
    workspaceIo: input.authority
      ? createWorkspaceIoAuthority(input.authority.workspace.hostRoot)
      : undefined,
  }
}

export function runWithAgentRunScope<T>(
  scope: AgentRunScope,
  callback: () => T,
): T {
  return runWithRuntimeExecutionContext(
    scope.runtimeContext,
    () => {
      // R2 PR-9：工具执行（executeProcess）要求 Trusted Execution Authority ——
      // 由 run scope 注入 ALS（每个 step 幂等）。
      if (scope.authority) setExecutionAuthority(scope.authority)
      // IC01：统一工作区 I/O 权威注入（读取根以 hostRoot 为权威）。
      if (scope.workspaceIo) setWorkspaceIoAuthority(scope.workspaceIo)
      return runWithRuntimeFileStateContext(scope.fileState, callback)
    },
  )
}
