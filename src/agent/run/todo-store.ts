export interface Todo {
  id: string
  content: string
  status: "pending" | "in_progress" | "completed"
  priority: "high" | "medium" | "low"
  createdAt: number
  updatedAt: number
}

export interface TodoStore {
  todos: Todo[]
  nextId: number
}

export function createTodoStore(): TodoStore {
  return {
    todos: [],
    nextId: 1,
  }
}

export function clearTodoStore(store: TodoStore): void {
  store.todos = []
  store.nextId = 1
}
