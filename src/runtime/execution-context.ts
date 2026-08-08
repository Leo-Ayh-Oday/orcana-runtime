import { AsyncLocalStorage } from "node:async_hooks"
import { createPlanStore, type PlanStore } from "../agent/run/plan-store"
import type { AgentRunToolRegistry } from "../agent/run/tool-registry"
import type { TrustedExecutionAuthority } from "./linux/contracts"
import { createRetryLedger, type RetryLedger } from "./retry-ledger"

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

// ── PR-6：执行身份（ProcessRequest 注入源，取消 tool-run 匿名执行） ──

export interface ExecutionIdentity {
  runId?: string
  nodeRunId?: string
  agentId?: string
  domainId?: string
  assignmentId?: string
  sessionId?: string
}

const EXECUTION_IDENTITY = createRuntimeContextKey<ExecutionIdentity>(
  "execution-identity",
  () => ({}),
)

/** 当前运行时执行身份（AgentRunScope 设置；未设置时为空对象）。 */
export function getExecutionIdentity(): ExecutionIdentity {
  return getRuntimeContextValue(EXECUTION_IDENTITY)
}

/** 设置当前运行时执行身份（agentLoop 进入前；工具执行注入用）。 */
export function setExecutionIdentity(identity: ExecutionIdentity): void {
  setRuntimeContextValue(EXECUTION_IDENTITY, identity)
}

// ── R2 PR-9：Trusted Execution Authority（INV-A 唯一身份来源） ──

const EXECUTION_AUTHORITY = createRuntimeContextKey<TrustedExecutionAuthority | undefined>(
  "execution-authority",
  () => undefined,
)

/** 注入可信执行权威（Agent Run Scope 进入前设置；子 Agent 生成新 Authority）。
 *  传 undefined 清除当前权威（作用域退出）。 */
export function setExecutionAuthority(authority: TrustedExecutionAuthority | undefined): void {
  setRuntimeContextValue(EXECUTION_AUTHORITY, authority)
}

/** 当前可信执行权威（未设置时 undefined）。 */
export function getExecutionAuthority(): TrustedExecutionAuthority | undefined {
  return getRuntimeContextValue(EXECUTION_AUTHORITY)
}

/** 要求存在可信执行权威（Linux enabled 执行路径必须存在；缺失即 fail-closed）。 */
export function requireExecutionAuthority(): TrustedExecutionAuthority {
  const authority = getRuntimeContextValue(EXECUTION_AUTHORITY)
  if (!authority) {
    throw new Error("No trusted execution authority: Linux execution requires an AgentRunScope with registered workspace")
  }
  return authority
}

// ── PR-GATE-06：Run 级 RetryLedger（各层统一重试预算） ──

const RUN_RETRY_LEDGER = createRuntimeContextKey<RetryLedger>(
  "run-retry-ledger",
  () => createRetryLedger(),
)

/**
 * 当前 Run 的统一重试预算账本。惰性创建并缓存进 context（同一 Run 内
 * 所有层共享同一实例 —— 这是 PR-GATE-06 的核心语义；不缓存会在
 * legacy/无 ALS 路径每次调用都新建 ledger，预算形同虚设）。
 */
export function getRunRetryLedger(): RetryLedger {
  const context = getActiveRuntimeExecutionContext() ?? legacyCompatibilityContext
  if (context.values.has(RUN_RETRY_LEDGER.id)) {
    return context.values.get(RUN_RETRY_LEDGER.id) as RetryLedger
  }
  const ledger = createRetryLedger()
  context.values.set(RUN_RETRY_LEDGER.id, ledger)
  return ledger
}

/** 显式覆盖当前 Run 的重试账本（harness 注入共享 ledger 用）。 */
export function setRunRetryLedger(ledger: RetryLedger): void {
  setRuntimeContextValue(RUN_RETRY_LEDGER, ledger)
}

/** 将 ledger 直接绑定到指定 context（agentLoop 继承 harness 传入的
 *  Run 级账本 —— 预算跨 harness scope 与 loop ALS 上下文共享）。 */
export function bindRunRetryLedgerToContext(
  context: RuntimeExecutionContext,
  ledger: RetryLedger,
): void {
  context.values.set(RUN_RETRY_LEDGER.id, ledger)
}
