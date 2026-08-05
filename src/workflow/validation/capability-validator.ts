/** Capability validator (G2): every handler must be registered and the
 *  spec must only use read-only handlers in read-only mode.
 *
 *  The handler whitelist lives in the registry; this validator receives the
 *  set of known handler ids (from the runtime registry) and fails specs
 *  that reference unknown handlers or write handlers.
 */

export interface CapabilityIssue {
  code: "unknown_handler" | "write_handler"
  message: string
}

export interface CapabilityContext {
  knownHandlers: Set<string>
  /** Handler ids known to be read-only (whitelist). */
  readonlyHandlers: Set<string>
}

export function validateCapabilities(
  nodes: Array<{ id: string; handler: string }>,
  ctx: CapabilityContext,
): CapabilityIssue[] {
  const issues: CapabilityIssue[] = []
  for (const node of nodes) {
    if (!ctx.knownHandlers.has(node.handler)) {
      issues.push({
        code: "unknown_handler",
        message: `workflow: node "${node.id}" references unknown handler "${node.handler}"`,
      })
      continue
    }
    if (!ctx.readonlyHandlers.has(node.handler)) {
      issues.push({
        code: "write_handler",
        message: `workflow: node "${node.id}" uses write handler "${node.handler}" in read-only mode`,
      })
    }
  }
  return issues
}
