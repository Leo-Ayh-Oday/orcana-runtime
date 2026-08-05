/** Schema validator (G2): shallow node input typing.
 *
 *  Full per-tool input schemas live in the ToolDefs and are enforced at
 *  execution time (buildTool preflight). This validator catches structural
 *  mistakes early (non-object inputs, wrong value types) so invalid specs
 *  fail at compile time, not mid-run.
 */

export interface SchemaIssue {
  code: "invalid_input"
  message: string
}

export interface SchemaContext {
  /** handler id → minimal allowed input type: "object" | "array" | "any" */
  handlerInputKind: Record<string, "object" | "array" | "any">
}

export function validateSchema(
  nodes: Array<{ id: string; handler: string; input: unknown }>,
  ctx: SchemaContext,
): SchemaIssue[] {
  const issues: SchemaIssue[] = []
  for (const node of nodes) {
    const kind = ctx.handlerInputKind[node.handler] ?? "object"
    if (kind === "any") continue
    const input = node.input
    if (kind === "object" && (typeof input !== "object" || input === null || Array.isArray(input))) {
      issues.push({
        code: "invalid_input",
        message: `workflow: node "${node.id}" (${node.handler}) input must be an object`,
      })
    }
    if (kind === "array" && !Array.isArray(input)) {
      issues.push({
        code: "invalid_input",
        message: `workflow: node "${node.id}" (${node.handler}) input must be an array`,
      })
    }
  }
  return issues
}
