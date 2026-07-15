/** Tool system — single factory, zero external deps. Port from Python tool_system.py. */

import type { ToolCategory, PermissionLevel } from "../agent/permission"
import { projectToolContract, type ToolContract, type ToolContractMetadata } from "./tool-contract"

export interface ToolExecutionContext {
  abortSignal?: AbortSignal
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

export const Result = {
  ok(content: string, metadata?: Record<string, unknown>): ToolResult {
    return { success: true, content, metadata }
  },
  fail(error: string, content?: string): ToolResult {
    return { success: false, content: content ?? error, error }
  },
  blocked(reason: string): ToolResult {
    return { success: false, content: `[blocked] ${reason}`, error: reason, metadata: { blocked: true } }
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

/** True when running non-interactively — CLI one-shot mode, CI, tests. */
export function isNonInteractive(): boolean {
  try {
    // Explicit env override
    if (process.env.DEEPSEEK_INTERACTIVE === "1") return false
    if (process.env.DEEPSEEK_NON_INTERACTIVE === "1") return true
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
  const execute = async (params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> => {
    if (defn.validate) {
      const vr = defn.validate(params)
      if (!vr.ok) return Result.blocked(vr.message ?? "invalid input")
    }
    if (shouldRequireConfirmation(defn) && !params.confirm) {
      return Result.blocked(`${defn.userFacingName ?? defn.name} requires confirmation — set confirm: true`)
    }
    try {
      const result = await defn.execute(params, undefined, context)
      return result
    } catch (e) {
      return Result.fail(e instanceof Error ? e.message : String(e))
    }
  }

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

  return { defn, contract, execute, executeStream: defn.executeStream, toAnthropicSchema }
}

export function buildTools(...defs: ToolDef[]): ContractToolDescriptor[] {
  return defs.map(buildTool)
}

export type { ToolContract, ToolContractMetadata } from "./tool-contract"
export { projectToolContract } from "./tool-contract"
