import { AsyncLocalStorage } from "node:async_hooks"

export type RuntimeExecutionContext = Map<symbol, unknown>

const runtimeContextStorage = new AsyncLocalStorage<RuntimeExecutionContext>()
const fallbackRuntimeContext: RuntimeExecutionContext = new Map()

export function createRuntimeExecutionContext(): RuntimeExecutionContext {
  return new Map()
}

export function runWithRuntimeExecutionContext<T>(
  context: RuntimeExecutionContext,
  callback: () => T,
): T {
  return runtimeContextStorage.run(context, callback)
}

export function getRuntimeContextValue<T>(key: symbol, fallback: T): T {
  const context = runtimeContextStorage.getStore() ?? fallbackRuntimeContext
  return context.has(key) ? context.get(key) as T : fallback
}

export function setRuntimeContextValue<T>(key: symbol, value: T): void {
  const context = runtimeContextStorage.getStore() ?? fallbackRuntimeContext
  context.set(key, value)
}
