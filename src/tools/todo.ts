/** TodoWrite tool — task progress tracking for the agent.
 *
 *  Allows the model to proactively manage a task list during complex work.
 *  Unlike the MasterPlan `task` tool (which tracks high-level plan nodes),
 *  TodoWrite tracks fine-grained implementation steps within a single task.
 *
 *  Design:
 *    - Simple CRUD: create/update/delete todos
 *    - Status: pending | in_progress | completed
 *    - Priority: high | medium | low
 *    - Stored in tool metadata (not persisted across sessions)
 *    - Displayed in TUI as a progress panel
 */

import {
  clearTodoStore,
  type Todo,
  type TodoStore,
} from "../agent/run/todo-store"
import type { ToolDef } from "./registry"
import { Result } from "./registry"

export type { Todo, TodoStore } from "../agent/run/todo-store"

function formatTodoList(todos: Todo[]): string {
  if (todos.length === 0) return "任务列表为空"

  const sorted = [...todos].sort((a, b) => {
    // Sort by status (in_progress > pending > completed), then priority (high > medium > low)
    const statusOrder = { in_progress: 0, pending: 1, completed: 2 }
    const priorityOrder = { high: 0, medium: 1, low: 2 }
    if (statusOrder[a.status] !== statusOrder[b.status]) {
      return statusOrder[a.status] - statusOrder[b.status]
    }
    return priorityOrder[a.priority] - priorityOrder[b.priority]
  })

  const lines = sorted.map(todo => {
    const icon = { pending: "⏳", in_progress: "🔄", completed: "✅" }[todo.status]
    const priorityIcon = { high: "🔴", medium: "🟡", low: "🟢" }[todo.priority]
    return `${icon} ${priorityIcon} #${todo.id}: ${todo.content}`
  })

  const summary = {
    total: todos.length,
    pending: todos.filter(t => t.status === "pending").length,
    in_progress: todos.filter(t => t.status === "in_progress").length,
    completed: todos.filter(t => t.status === "completed").length,
  }

  return [
    `任务列表 (${summary.completed}/${summary.total} 完成)`,
    ...lines,
  ].join("\n")
}

const todoToolDefinitions = new WeakSet<ToolDef>()

/**
 * Bind TodoWrite to one Agent Run's in-memory store. Passing null creates a
 * catalog-only descriptor that fails closed until AgentRunScope rebinds it.
 */
export function createTodoWriteTool(todoStore: TodoStore | null): ToolDef {
  const todoWriteTool: ToolDef = {
    name: "todo_write",
    description:
      "管理任务列表，追踪复杂任务的进度。\n" +
      "\n" +
      "## 什么时候用它\n" +
      "- 任务涉及 3+ 个步骤（如「读文件→修改→测试→提交」）\n" +
      "- 需要拆解大任务为小步骤\n" +
      "- 想让用户看到当前进度\n" +
      "\n" +
      "## 操作\n" +
      "- list: 查看所有任务\n" +
      "- add: 添加任务。参数 content（内容）, priority（优先级，可选，默认 medium）\n" +
      "- update: 更新任务。参数 id（任务 ID）, content/status/priority（至少一个）\n" +
      "- delete: 删除任务。参数 id（任务 ID）\n" +
      "- reset: 清空所有任务\n" +
      "\n" +
      "## 状态\n" +
      "- pending: 待处理\n" +
      "- in_progress: 进行中（同时只能有一个）\n" +
      "- completed: 已完成",
    isReadonly: false,
    isConcurrencySafe: false,
    userFacingName: "任务追踪",
    contract: {
      sideEffects: ["runtime_state"],
      stateUpdates: ["runtime_state"],
    },
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          description: "list | add | update | delete | reset",
        },
        id: {
          type: "string",
          description: "任务 ID（update/delete 时必需）",
        },
        content: {
          type: "string",
          description: "任务内容（add 时必需，update 时可选）",
        },
        status: {
          type: "string",
          description: "pending | in_progress | completed（update 时可选）",
        },
        priority: {
          type: "string",
          description: "high | medium | low（add/update 时可选，默认 medium）",
        },
      },
      required: ["operation"],
    },
    execute: async (params: Record<string, unknown>) => {
      if (!todoStore) {
        return Result.fail("todo_write requires an active AgentRunScope")
      }
  
      const currentTodos = todoStore.todos
      const op = String(params.operation ?? "")
  
      switch (op) {
        case "list": {
          return Result.ok(formatTodoList(currentTodos))
        }
  
        case "add": {
          const content = String(params.content ?? "").trim()
          if (!content) {
            return Result.fail("add 操作需要 content 参数")
          }
  
          const priority = (["high", "medium", "low"].includes(String(params.priority))
            ? String(params.priority)
            : "medium") as "high" | "medium" | "low"
  
          const now = Date.now()
          const todo: Todo = {
            id: String(todoStore.nextId++),
            content,
            status: "pending",
            priority,
            createdAt: now,
            updatedAt: now,
          }
  
          currentTodos.push(todo)
          return Result.ok(
            `已添加任务 #${todo.id}: ${todo.content}\n\n${formatTodoList(currentTodos)}`,
          )
        }
  
        case "update": {
          const id = String(params.id ?? "")
          if (!id) {
            return Result.fail("update 操作需要 id 参数")
          }
  
          const todo = currentTodos.find(t => t.id === id)
          if (!todo) {
            return Result.fail(`任务 #${id} 不存在`)
          }
  
          // Update content if provided
          if (params.content !== undefined) {
            const content = String(params.content).trim()
            if (content) {
              todo.content = content
            }
          }
  
          // Update status if provided
          if (params.status !== undefined) {
            const status = String(params.status)
            if (["pending", "in_progress", "completed"].includes(status)) {
              // If marking as in_progress, ensure no other task is in_progress
              if (status === "in_progress") {
                const otherInProgress = currentTodos.find(
                  t => t.status === "in_progress" && t.id !== id,
                )
                if (otherInProgress) {
                  otherInProgress.status = "pending"
                  otherInProgress.updatedAt = Date.now()
                }
              }
              todo.status = status as "pending" | "in_progress" | "completed"
            }
          }
  
          // Update priority if provided
          if (params.priority !== undefined) {
            const priority = String(params.priority)
            if (["high", "medium", "low"].includes(priority)) {
              todo.priority = priority as "high" | "medium" | "low"
            }
          }
  
          todo.updatedAt = Date.now()
          return Result.ok(
            `已更新任务 #${todo.id}: ${todo.content} (${todo.status})\n\n${formatTodoList(currentTodos)}`,
          )
        }
  
        case "delete": {
          const id = String(params.id ?? "")
          if (!id) {
            return Result.fail("delete 操作需要 id 参数")
          }
  
          const index = currentTodos.findIndex(t => t.id === id)
          if (index === -1) {
            return Result.fail(`任务 #${id} 不存在`)
          }
  
          const deleted = currentTodos.splice(index, 1)[0]
          if (!deleted) {
            return Result.fail(`任务 #${id} 删除失败`)
          }
          return Result.ok(
            `已删除任务 #${deleted.id}: ${deleted.content}\n\n${formatTodoList(currentTodos)}`,
          )
        }
  
        case "reset": {
          clearTodoStore(todoStore)
          return Result.ok("已清空任务列表")
        }
  
        default:
          return Result.fail(`未知操作: ${op}。支持: list | add | update | delete | reset`)
      }
    },
  }
  todoToolDefinitions.add(todoWriteTool)
  return todoWriteTool
}

export function isTodoWriteToolDefinition(defn: ToolDef): boolean {
  return todoToolDefinitions.has(defn)
}

// Static catalog identity only. AgentRunScope replaces this descriptor before
// production execution, so the catalog itself owns no mutable task state.
export const TODO_WRITE_TOOL: ToolDef = createTodoWriteTool(null)

export { formatTodoList }
