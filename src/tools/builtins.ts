import { CODEGRAPH_TOOLS } from "./codegraph"
import { FILE_TOOLS } from "./file"
import { GIT_TOOLS } from "./git"
import { LSP_TOOLS } from "./lsp"
import { META_BUILTIN_TOOL_DEFS } from "./meta"
import type { ToolDef } from "./registry"
import { WEB_SEARCH } from "./search"
import { START_SERVICE_TOOL } from "./service"
import { SHELL_TOOL } from "./shell"
import { TYPECHECK_TOOL } from "./typescript"
import { WEB_FETCH_TOOL } from "./webfetch"

const CORE_BUILTIN_TOOL_DEFS: readonly ToolDef[] = Object.freeze([
  ...FILE_TOOLS,
  SHELL_TOOL,
  START_SERVICE_TOOL,
  ...GIT_TOOLS,
  WEB_SEARCH,
  WEB_FETCH_TOOL,
  ...CODEGRAPH_TOOLS,
  ...LSP_TOOLS,
  TYPECHECK_TOOL,
])

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
