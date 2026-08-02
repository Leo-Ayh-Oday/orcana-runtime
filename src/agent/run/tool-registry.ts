import { createTaskTool, isTaskToolDefinition } from "../../tools/meta"
import { createTodoWriteTool, isTodoWriteToolDefinition } from "../../tools/todo"
import { buildTool, type ToolDescriptor } from "../../tools/registry"
import type { PlanStore } from "./plan-store"
import type { TodoStore } from "./todo-store"

export interface AgentRunToolRegistry {
  readonly tools: ToolDescriptor[]
  get(name: string): ToolDescriptor | undefined
  has(name: string): boolean
}

/**
 * Creates a per-run registry and rebinds runtime-owned stateful tools to that
 * run's stores. Stateless/read-only descriptors retain their trusted identity.
 */
export function createAgentRunToolRegistry(
  tools: readonly ToolDescriptor[],
  planStore: PlanStore,
  todoStore: TodoStore,
): AgentRunToolRegistry {
  const runTools = tools.map(tool => {
    if (isTaskToolDefinition(tool.defn)) {
      return buildTool(createTaskTool(planStore))
    }
    if (isTodoWriteToolDefinition(tool.defn)) {
      return buildTool(createTodoWriteTool(todoStore))
    }
    return tool
  })
  const byName = new Map(runTools.map(tool => [tool.defn.name, tool]))

  return {
    tools: runTools,
    get: name => byName.get(name),
    has: name => byName.has(name),
  }
}

export function createEmptyAgentRunToolRegistry(): AgentRunToolRegistry {
  return {
    tools: [],
    get: () => undefined,
    has: () => false,
  }
}
