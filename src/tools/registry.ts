/** Tool system — single factory, zero external deps. Port from Python tool_system.py. */

import type { ToolCategory, PermissionLevel } from "../agent/permission"
import { validateToolContractFreshness, type ToolFreshnessApproval } from "../file-state"
import type { FileStateStatus } from "../file-state"
import { projectToolContract, type ToolContract, type ToolContractMetadata } from "./tool-contract"

export interface ToolExecutionContext {
  abortSignal?: AbortSignal
  freshness?: ToolFreshnessApproval
  /** RC-19 Phase 2 (D7): the authoritative project root — relative tool paths
   *  resolve against this via resolveToolPath(), never process.cwd(). */
  projectRoot: string
  /** Extra roots a read may reach (defaults to [projectRoot]). */
  readableRoots?: string[]
  /** Extra roots a write may reach (defaults to [projectRoot]). */
  writableRoots?: string[]
}

export interface ToolDef {
  name: string
  description: string
  isReadonly: boolean
  isConcurrencySafe?: boolean
  requiresConfirmation?: boolean
  userFacingName?: string
  /** Permission category for access control (default: "shell") */
  category?: ToolCategory
  /** Override default permission level for this tool */
  permission?: PermissionLevel
  /** Declarative metadata used by the canonical, handler-free ToolContract projection. */
  contract?: ToolContractMetadata
  /** Required for freshness-bound writes: the handler consumes approval snapshots and commits through PatchTransaction. */
  managesFreshnessApproval?: boolean
  inputSchema: Record<string, unknown>
  validate?: (params: Record<string, unknown>) => { ok: boolean; message?: string }
  execute: (
    params: Record<string, unknown>,
    onProgress?: (chunk: string) => void,
    context?: ToolExecutionContext,
  ) => Promise<ToolResult> | ToolResult
  /** Optional: streaming variant that yields chunks during execution */
  executeStream?: (
    params: Record<string, unknown>,
    context?: ToolExecutionContext,
  ) => AsyncGenerator<{ type: "progress"; data: string } | { type: "done"; data: ToolResult }>
}

export type ToolResult =
  | { success: true; content: string; metadata?: Record<string, unknown> }
  | { success: false; content: string; error: string; metadata?: Record<string, unknown> }

export interface FreshnessGateMetadata extends Record<string, unknown> {
  gate: "freshness"
  freshness: {
    path: string
    status: FileStateStatus
    reason: string
  }
}

export const Result = {
  ok(content: string, metadata?: Record<string, unknown>): ToolResult {
    return { success: true, content, metadata }
  },
  fail(error: string, content?: string): ToolResult {
    return { success: false, content: content ?? error, error }
  },
  /** RT-7: failure with structured metadata (exitCode, signal, stdout…). */
  failWithMetadata(error: string, metadata?: Record<string, unknown>): ToolResult {
    return { success: false, content: error, error, metadata }
  },
  blocked(reason: string, metadata?: Record<string, unknown>): ToolResult {
    return {
      success: false,
      content: `[blocked] ${reason}`,
      error: reason,
      metadata: { ...metadata, blocked: true },
    }
  },
  freshnessBlocked(path: string, status: FileStateStatus, reason: string): ToolResult {
    return Result.blocked(`FreshnessGate blocked write for ${path}: ${reason}`, {
      gate: "freshness",
      freshness: { path, status, reason },
    } satisfies FreshnessGateMetadata)
  },
}

export interface ToolDescriptor {
  defn: ToolDef
  /** Present on descriptors created by buildTool/buildTools. Optional for legacy structural mocks. */
  readonly contract?: ToolContract
  execute: (params: Record<string, unknown>, context?: ToolExecutionContext) => Promise<ToolResult>
  executeStream?: ToolDef["executeStream"]
  toAnthropicSchema: () => Record<string, unknown>
}

const runtimeBuiltToolExecutors = new WeakMap<object, ToolDescriptor["execute"]>()

/** True only for an untampered descriptor created by this runtime's buildTool(). */
export function isRuntimeBuiltToolDescriptor(tool: ToolDescriptor): boolean {
  return runtimeBuiltToolExecutors.get(tool) === tool.execute
}

/** True when running non-interactively — CLI one-shot mode, CI, tests. */
export function isNonInteractive(): boolean {
  try {
    // Explicit env override
    if (process.env.ORCANA_INTERACTIVE === "1") return false
    if (process.env.ORCANA_NON_INTERACTIVE === "1") return true
    // CLI one-shot: prompt passed as argument → no interactive session
    if (process.argv.length > 2 && process.argv.slice(2).some(a => !a.startsWith("-"))) return true
    // TTY check: stdin is not a terminal → non-interactive
    if (process.stdin?.isTTY !== true) return true
    return false
  } catch {
    return false
  }
}

function shouldRequireConfirmation(defn: ToolDef): boolean {
  if (!defn.requiresConfirmation) return false
  // Non-interactive mode: the user already gave intent via the prompt.
  // Requiring confirm:true just causes blocked tool calls that break
  // Anthropic message format compliance on retry.
  if (isNonInteractive()) return false
  return true
}

export type ContractToolDescriptor = ToolDescriptor & { readonly contract: ToolContract }

export function buildTool(defn: ToolDef): ContractToolDescriptor {
  const contract = projectToolContract(defn)
  if (contract.state.requirement !== "none") {
    if (defn.executeStream) {
      throw new Error(`Tool ${defn.name} cannot combine streaming execution with a freshness requirement`)
    }
    if (defn.managesFreshnessApproval !== true) {
      throw new Error(`Tool ${defn.name} declares a freshness requirement without a managed freshness transaction`)
    }
  }

  const preflight = async (
    params: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<{ ok: true; context?: ToolExecutionContext } | { ok: false; result: ToolResult }> => {
    if (defn.validate) {
      const vr = defn.validate(params)
      if (!vr.ok) return { ok: false, result: Result.blocked(vr.message ?? "invalid input") }
    }
    if (shouldRequireConfirmation(defn) && !params.confirm) {
      return {
        ok: false,
        result: Result.blocked(`${defn.userFacingName ?? defn.name} requires confirmation — set confirm: true`),
      }
    }
    // IC01（PROJECT_ROOT_CWD_MISMATCH = 0）：freshness preflight 与工具执行
    // 使用同一 authority base —— 相对路径绑定 context.projectRoot。
    const freshness = await validateToolContractFreshness(contract, params, {
      abortSignal: context?.abortSignal,
      projectRoot: context?.projectRoot,
    })
    if (!freshness.ok) {
      return {
        ok: false,
        result: Result.freshnessBlocked(freshness.path, freshness.status, freshness.reason),
      }
    }
    return {
      ok: true,
      // Spread only a present context — an absent one stays absent
      // (projectRoot: string must not widen to undefined).
      context: context ? { ...context, freshness: freshness.approval } : undefined,
    }
  }

  const execute = async (params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> => {
    const prepared = await preflight(params, context)
    if (!prepared.ok) return prepared.result
    try {
      const result = await defn.execute(params, undefined, prepared.context)
      return result
    } catch (e) {
      return Result.fail(e instanceof Error ? e.message : String(e))
    }
  }

  const executeStream: ToolDef["executeStream"] = defn.executeStream
    ? async function* (params: Record<string, unknown>, context?: ToolExecutionContext) {
      const prepared = await preflight(params, context)
      if (!prepared.ok) {
        yield { type: "done", data: prepared.result }
        return
      }
      yield* defn.executeStream!(params, prepared.context)
    }
    : undefined

  const toAnthropicSchema = () => {
    const inputSchema = JSON.parse(JSON.stringify(defn.inputSchema)) as Record<string, unknown>
    if (shouldRequireConfirmation(defn) && inputSchema.type === "object") {
      const properties = (inputSchema.properties as Record<string, unknown> | undefined) ?? {}
      properties.confirm = {
        type: "boolean",
        description: "Must be true to confirm this write operation.",
      }
      inputSchema.properties = properties
      const required = Array.isArray(inputSchema.required) ? [...inputSchema.required] : []
      if (!required.includes("confirm")) required.push("confirm")
      inputSchema.required = required
    }
    return {
      name: defn.name,
      description: defn.description,
      input_schema: inputSchema,
    }
  }

  const descriptor: ContractToolDescriptor = { defn, contract, execute, executeStream, toAnthropicSchema }
  runtimeBuiltToolExecutors.set(descriptor, execute)
  return descriptor
}

export function buildTools(...defs: ToolDef[]): ContractToolDescriptor[] {
  return defs.map(buildTool)
}

export type { ToolContract, ToolContractMetadata } from "./tool-contract"
export { projectToolContract } from "./tool-contract"
