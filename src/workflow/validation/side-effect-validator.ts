/** Side-effect validator (G2): read-only mode ⇒ every node is read-only.
 *
 *  This is the compile-time third layer of write protection (after handler
 *  registration and per-call isReadonly re-check): templates and compiled
 *  plans are rejected here if any node is not in the read-only whitelist.
 */

export interface SideEffectIssue {
  code: "write_node_in_readonly_spec"
  message: string
}

export function validateSideEffects(
  nodes: Array<{ id: string; handler: string }>,
  readonlyHandlers: Set<string>,
): SideEffectIssue[] {
  const issues: SideEffectIssue[] = []
  for (const node of nodes) {
    if (!readonlyHandlers.has(node.handler)) {
      issues.push({
        code: "write_node_in_readonly_spec",
        message: `workflow: node "${node.id}" (${node.handler}) has write side effects — rejected in read-only mode`,
      })
    }
  }
  return issues
}
