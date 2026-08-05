/** Handler registry (G1): read-only handler whitelist.
 *
 *  Two-layer write protection (plan G1 §4.1):
 *    1. registration — only isReadonly tools can be registered; registering
 *       a write tool throws;
 *    2. execution — the tool executor re-verifies isReadonly before every
 *       call (fail-closed even if a handler was injected directly).
 */

import type { ContractToolDescriptor } from "../../tools/registry"

export type WorkflowHandler = (input: Record<string, unknown>) => Promise<unknown>

export interface HandlerDef {
  id: string
  description: string
  run: WorkflowHandler
}

export class HandlerRegistry {
  private readonly handlers = new Map<string, HandlerDef>()

  /** Register a read-only tool descriptor under a handler id. */
  registerTool(handlerId: string, tool: ContractToolDescriptor): void {
    if (tool.defn.isReadonly !== true) {
      throw new Error(`workflow: write tool "${tool.defn.name}" cannot be registered as a read-only handler`)
    }
    this.handlers.set(handlerId, {
      id: handlerId,
      description: tool.defn.description ?? tool.defn.name,
      run: async input => {
        const result = await tool.execute(input)
        if (!result.success) {
          throw new Error(result.error ?? result.content ?? `tool ${tool.defn.name} failed`)
        }
        return { content: result.content, metadata: result.metadata ?? {} }
      },
    })
  }

  /** Register a deterministic reducer (pure function of inputs). */
  register(handlerId: string, description: string, run: WorkflowHandler): void {
    this.handlers.set(handlerId, { id: handlerId, description, run })
  }

  has(handlerId: string): boolean {
    return this.handlers.has(handlerId)
  }

  get(handlerId: string): HandlerDef | undefined {
    return this.handlers.get(handlerId)
  }

  list(): string[] {
    return [...this.handlers.keys()]
  }
}
