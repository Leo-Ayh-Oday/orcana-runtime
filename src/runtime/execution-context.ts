import { AsyncLocalStorage } from "node:async_hooks"
import { createPlanStore, type PlanStore } from "../agent/run/plan-store"
import type { AgentRunToolRegistry } from "../agent/run/tool-registry"

export interface RuntimeContextKey<T> {
  readonly id: symbol
  readonly name: string
  readonly defaultValue: () => T
}

export interface RuntimeExecutionContext {
  readonly id: string
  readonly planStore: PlanStore
  readonly toolRegistry: AgentRunToolRegistry
  readonly values: Map<symbol, unknown>
}

export interface CreateRuntimeExecutionContextInput {
  id?: string
  planStore?: PlanStore
  toolRegistry?: AgentRunToolRegistry
}

const runtimeContextStorage = new AsyncLocalStorage<RuntimeExecutionContext>()
let nextRuntimeContextId = 0

function createEmptyToolRegistry(): AgentRunToolRegistry {
  return {
    tools: [],
    get: () => undefined,
    has: () => false,
  }
}

/**
 * Compatibility-only context for legacy direct module tests and callers that
 * have not entered an AgentRunScope. Production agent execution always has an
 * AsyncLocalStorage context and never reads this store.
 */
const legacyCompatibilityContext: RuntimeExecutionContext = {
  id: "legacy-compatibility",
  planStore: createPlanStore(),
  toolRegistry: createEmptyToolRegistry(),
  values: new Map(),
}

export function createRuntimeContextKey<T>(
  name: string,
  defaultValue: () => T,
): RuntimeContextKey<T> {
  return Object.freeze({
    id: Symbol(name),
    name,
    defaultValue,
  })
}

export function createRuntimeExecutionContext(
  input: CreateRuntimeExecutionContextInput = {},
): RuntimeExecutionContext {
  nextRuntimeContextId++
  return {
    id: input.id ?? `agent-run-scope-${nextRuntimeContextId}`,
    planStore: input.planStore ?? createPlanStore(),
    toolRegistry: input.toolRegistry ?? createEmptyToolRegistry(),
    values: new Map(),
  }
}

export function runWithRuntimeExecutionContext<T>(
  context: RuntimeExecutionContext,
  callback: () => T,
): T {
  return runtimeContextStorage.run(context, callback)
}

export function getActiveRuntimeExecutionContext(): RuntimeExecutionContext | undefined {
  return runtimeContextStorage.getStore()
}

export function requireRuntimeExecutionContext(): RuntimeExecutionContext {
  const context = runtimeContextStorage.getStore()
  if (!context) {
    throw new Error("No active AgentRunScope")
  }
  return context
}

export function isLegacyRuntimeExecutionContext(): boolean {
  return runtimeContextStorage.getStore() === undefined
}

export function getRuntimeContextValue<T>(key: RuntimeContextKey<T>): T
/** @deprecated Use a typed RuntimeContextKey. */
export function getRuntimeContextValue<T>(key: symbol, fallback: T): T
export function getRuntimeContextValue<T>(
  key: RuntimeContextKey<T> | symbol,
  fallback?: T,
): T {
  const context = runtimeContextStorage.getStore() ?? legacyCompatibilityContext
  const id = typeof key === "symbol" ? key : key.id
  if (context.values.has(id)) return context.values.get(id) as T
  return typeof key === "symbol" ? fallback as T : key.defaultValue()
}

export function setRuntimeContextValue<T>(key: RuntimeContextKey<T>, value: T): void
/** @deprecated Use a typed RuntimeContextKey. */
export function setRuntimeContextValue<T>(key: symbol, value: T): void
export function setRuntimeContextValue<T>(
  key: RuntimeContextKey<T> | symbol,
  value: T,
): void {
  const context = runtimeContextStorage.getStore() ?? legacyCompatibilityContext
  const id = typeof key === "symbol" ? key : key.id
  context.values.set(id, value)
}
