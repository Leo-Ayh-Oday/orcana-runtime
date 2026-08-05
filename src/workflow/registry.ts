/** Default read-only handler registry (G1): 6 read-only tools + reducers.
 *
 *  Registration of a write tool throws — the whitelist is the first layer;
 *  the tool executor's isReadonly re-check is the second.
 *
 *  buildReadWriteRegistry (G3) additionally registers the write whitelist
 *  (apply_patch / run_process / run_targeted_verification) under
 *  single-writer semantics for read-write specs.
 */

import type { ContractToolDescriptor } from "../tools/registry"
import { HandlerRegistry } from "./execution/handler-registry"
import { dedupeValues, mergeDiagnostics } from "./reducers/dedupe"

export function buildReadonlyRegistry(tools: ContractToolDescriptor[]): HandlerRegistry {
  const registry = new HandlerRegistry()
  const byName = new Map(tools.map(t => [t.defn.name, t]))

  const register = (toolName: string): void => {
    const tool = byName.get(toolName)
    if (!tool) throw new Error(`workflow: tool "${toolName}" not found in runtime tool set`)
    registry.registerTool(`tool.${toolName}`, tool)
  }

  register("read_file")
  register("find_symbol")
  register("find_references")
  register("project_structure")
  register("git_diff")
  register("git_status")

  registerReducers(registry)
  return registry
}

/** G3: read-write registry — read-only whitelist + single-writer write tools.
 *  apply_patch registers the TRANSACTION tool (patches[] + atomic commit +
 *  rollback); the handler id stays tool.apply_patch. */
export function buildReadWriteRegistry(tools: ContractToolDescriptor[]): HandlerRegistry {
  const registry = buildReadonlyRegistry(tools)
  const byName = new Map(tools.map(t => [t.defn.name, t]))

  const registerWrite = (toolName: string, handlerId: string): void => {
    const tool = byName.get(toolName)
    if (!tool) throw new Error(`workflow: tool "${toolName}" not found in runtime tool set`)
    registry.registerWriteTool(handlerId, tool)
  }

  registerWrite("apply_patch_transaction", "tool.apply_patch")
  registerWrite("run_process", "tool.run_process")
  registerWrite("run_targeted_verification", "tool.run_targeted_verification")
  return registry
}

function registerReducers(registry: HandlerRegistry): void {
  registry.register("reduce.noop", "no-op ordering gate", async (_input: Record<string, unknown>) => null)
  registry.register("reduce.dedupe", "dedupe an array of values", async (input: Record<string, unknown>) => {
    if (!Array.isArray(input.values)) throw new Error("workflow: reduce.dedupe requires input.values: array")
    return dedupeValues(input.values as unknown[])
  })
  registry.register("reduce.merge_diagnostics", "merge diagnostic arrays (stable sort)", async (input: Record<string, unknown>) => {
    const groups = Array.isArray(input.groups)
      ? (input.groups as unknown[])
      : Object.values(input ?? {}).filter(Array.isArray)
    return mergeDiagnostics(groups as Array<import("./reducers/dedupe").DiagnosticEntry[] | undefined>)
  })
}
