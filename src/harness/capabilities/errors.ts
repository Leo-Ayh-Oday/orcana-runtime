/** Tool Runtime 2.0 (RT-1): standard tool error codes.
 *
 *  Every capability failure maps to one of these codes so callers (loop,
 *  node runtime, evals) can react structurally instead of parsing text.
 *  The canonical list mirrors docs/tool-runtime/execution-plan.md §4.4.
 */

export const TOOL_ERROR_CODES = [
  "INVALID_INPUT",
  "SCHEMA_VALIDATION_FAILED",
  "PERMISSION_DENIED",
  "APPROVAL_REQUIRED",
  "WRITABLE_ROOT_VIOLATION",
  "READABLE_ROOT_VIOLATION",
  "STALE_FILE",
  "BASE_HASH_MISMATCH",
  "PATCH_CONFLICT",
  "RIPPLE_BLOCKED",
  "TIMEOUT",
  "CANCELLED",
  "COMMAND_NOT_FOUND",
  "PROCESS_EXIT_NONZERO",
  "NETWORK_BLOCKED",
  "SSRF_BLOCKED",
  "RATE_LIMITED",
  "REMOTE_UNAVAILABLE",
  "OUTPUT_TOO_LARGE",
  "ARTIFACT_WRITE_FAILED",
  "LSP_UNAVAILABLE",
  "LSP_STALE",
  "VERIFICATION_FAILED",
  "MCP_UNTRUSTED_TOOL",
  "MCP_SCHEMA_INVALID",
  "INTERNAL_ERROR",
] as const

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number]

export type ToolErrorCategory =
  | "validation"
  | "permission"
  | "conflict"
  | "environment"
  | "network"
  | "timeout"
  | "internal"

export interface ToolErrorInfo {
  code: ToolErrorCode
  message: string
  retryable: boolean
  category: ToolErrorCategory
}

/** Default category/retryability per code — the single source of truth. */
const CODE_META: Readonly<Record<ToolErrorCode, { category: ToolErrorCategory; retryable: boolean }>> = {
  INVALID_INPUT: { category: "validation", retryable: false },
  SCHEMA_VALIDATION_FAILED: { category: "validation", retryable: false },
  PERMISSION_DENIED: { category: "permission", retryable: false },
  APPROVAL_REQUIRED: { category: "permission", retryable: false },
  WRITABLE_ROOT_VIOLATION: { category: "permission", retryable: false },
  READABLE_ROOT_VIOLATION: { category: "permission", retryable: false },
  STALE_FILE: { category: "conflict", retryable: true },
  BASE_HASH_MISMATCH: { category: "conflict", retryable: true },
  PATCH_CONFLICT: { category: "conflict", retryable: true },
  RIPPLE_BLOCKED: { category: "conflict", retryable: false },
  TIMEOUT: { category: "timeout", retryable: true },
  CANCELLED: { category: "timeout", retryable: false },
  COMMAND_NOT_FOUND: { category: "environment", retryable: false },
  PROCESS_EXIT_NONZERO: { category: "environment", retryable: false },
  NETWORK_BLOCKED: { category: "network", retryable: false },
  SSRF_BLOCKED: { category: "network", retryable: false },
  RATE_LIMITED: { category: "network", retryable: true },
  REMOTE_UNAVAILABLE: { category: "network", retryable: true },
  OUTPUT_TOO_LARGE: { category: "validation", retryable: false },
  ARTIFACT_WRITE_FAILED: { category: "environment", retryable: true },
  LSP_UNAVAILABLE: { category: "environment", retryable: false },
  LSP_STALE: { category: "conflict", retryable: true },
  VERIFICATION_FAILED: { category: "conflict", retryable: false },
  MCP_UNTRUSTED_TOOL: { category: "permission", retryable: false },
  MCP_SCHEMA_INVALID: { category: "validation", retryable: false },
  INTERNAL_ERROR: { category: "internal", retryable: false },
}

/** Throwable tool error carrying the standard code/category/retryability. */
export class ToolError extends Error {
  readonly code: ToolErrorCode
  readonly category: ToolErrorCategory
  readonly retryable: boolean

  constructor(code: ToolErrorCode, message: string, overrides?: Partial<Pick<ToolErrorInfo, "category" | "retryable">>) {
    super(message)
    this.name = "ToolError"
    this.code = code
    this.category = overrides?.category ?? CODE_META[code].category
    this.retryable = overrides?.retryable ?? CODE_META[code].retryable
  }

  toInfo(): ToolErrorInfo {
    return { code: this.code, message: this.message, retryable: this.retryable, category: this.category }
  }
}

/** Build a ToolErrorInfo without throwing. */
export function toolError(code: ToolErrorCode, message: string, overrides?: Partial<Pick<ToolErrorInfo, "category" | "retryable">>): ToolErrorInfo {
  return {
    code,
    message,
    category: overrides?.category ?? CODE_META[code].category,
    retryable: overrides?.retryable ?? CODE_META[code].retryable,
  }
}
