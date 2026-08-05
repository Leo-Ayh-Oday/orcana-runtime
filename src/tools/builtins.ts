import { ASK_USER_TOOL } from "./ask-user"
import { APPLY_PATCH_TOOL, APPLY_PATCH_TRANSACTION_TOOL } from "./apply-patch"
import { CODEGRAPH_TOOLS } from "./codegraph"
import { EDIT_SYMBOL_TOOL, FILE_TOOLS } from "./file"
import { GIT_TOOLS } from "./git"
import { LSP_DIAGNOSTICS, LSP_TOOLS } from "./lsp"
import { META_BUILTIN_TOOL_DEFS } from "./meta"
import { BUILD_CONTEXT_SLICE_TOOL, BUILD_REPO_MAP_TOOL, QUERY_REPO_MAP_TOOL } from "./repo-map"
import { RUN_PROCESS_TOOL, RUN_SHELL_SCRIPT_TOOL } from "./process"
import type { ToolDef } from "./registry"
import { WEB_SEARCH } from "./search"
import { SERVICE_TOOLS, START_SERVICE_TOOL } from "./service"
import { SHELL_TOOL } from "./shell"
import { TODO_WRITE_TOOL } from "./todo"
import { TYPECHECK_TOOL } from "./typescript"
import { CLASSIFY_COMMAND_FAILURE_TOOL, DISCOVER_VERIFICATION_TOOL, RUN_TARGETED_VERIFICATION_TOOL, VERIFY_CLAIM_TOOL } from "./verification"
import { WEB_FETCH_TOOL } from "./webfetch"

const CORE_BUILTIN_TOOL_DEFS: readonly ToolDef[] = Object.freeze([
  ...FILE_TOOLS,
  EDIT_SYMBOL_TOOL,
  APPLY_PATCH_TOOL,
  APPLY_PATCH_TRANSACTION_TOOL,
  SHELL_TOOL,
  RUN_PROCESS_TOOL,
  RUN_SHELL_SCRIPT_TOOL,
  ...SERVICE_TOOLS,
  START_SERVICE_TOOL,
  ...GIT_TOOLS,
  WEB_SEARCH,
  WEB_FETCH_TOOL,
  ...CODEGRAPH_TOOLS,
  BUILD_REPO_MAP_TOOL,
  QUERY_REPO_MAP_TOOL,
  BUILD_CONTEXT_SLICE_TOOL,
  ...LSP_TOOLS,
  TYPECHECK_TOOL,
  DISCOVER_VERIFICATION_TOOL,
  RUN_TARGETED_VERIFICATION_TOOL,
  CLASSIFY_COMMAND_FAILURE_TOOL,
  VERIFY_CLAIM_TOOL,
  TODO_WRITE_TOOL,
  ASK_USER_TOOL,
])

const TRUSTED_VERIFICATION_PRODUCERS = new Map<ToolDef, {
  execute: ToolDef["execute"]
  executeStream: ToolDef["executeStream"]
}>([
  [SHELL_TOOL, { execute: SHELL_TOOL.execute, executeStream: SHELL_TOOL.executeStream }],
  [TYPECHECK_TOOL, { execute: TYPECHECK_TOOL.execute, executeStream: TYPECHECK_TOOL.executeStream }],
  [LSP_DIAGNOSTICS, { execute: LSP_DIAGNOSTICS.execute, executeStream: LSP_DIAGNOSTICS.executeStream }],
])

/** Fixed identity allowlist for runtime-owned verification producers. */
export function isBuiltinVerificationProducer(defn: ToolDef): boolean {
  const trusted = TRUSTED_VERIFICATION_PRODUCERS.get(defn)
  return Boolean(
    trusted
    && trusted.execute === defn.execute
    && trusted.executeStream === defn.executeStream,
  )
}

/** Static built-ins in stable disclosure order. The array itself is immutable. */
export const BUILTIN_TOOL_DEFS: readonly ToolDef[] = Object.freeze([
  ...CORE_BUILTIN_TOOL_DEFS,
  ...META_BUILTIN_TOOL_DEFS,
])

/** Insert dynamic MCP tools before meta-tools, preserving the historical runtime order. */
export function assembleRuntimeToolDefs(mcpToolDefs: readonly ToolDef[]): ToolDef[] {
  const metaToolStart = BUILTIN_TOOL_DEFS.length - META_BUILTIN_TOOL_DEFS.length
  return [
    ...BUILTIN_TOOL_DEFS.slice(0, metaToolStart),
    ...mcpToolDefs,
    ...BUILTIN_TOOL_DEFS.slice(metaToolStart),
  ]
}
