/** MCP trust policy (RT-11): per-server trust model for tool disclosure.
 *
 *  Why: MCP servers are third-party code; a server's tool annotations cannot
 *  be trusted to describe its own danger. The local policy decides risk and
 *  read-only-ness; annotations are treated as hints only.
 *
 *  Default posture: unknown tools are non-readonly and high-risk, and every
 *  non-readonly call requires first-time confirmation (the existing
 *  confirm-flow in the tool registry).
 */

export type MCPTrustLevel = "untrusted" | "restricted" | "trusted"

export interface MCPTrustPolicy {
  /** Server trust tier (default "untrusted"). */
  trust: MCPTrustLevel
  /** If non-empty, only tools matching at least one pattern are registered. */
  allowedToolPatterns: string[]
  /** Tools matching any pattern are never registered. Wins over allowlist. */
  deniedToolPatterns: string[]
  /** Risk level applied to tools that are not proven read-only (0–5, default 4). */
  defaultRiskLevel: number
  /** Whether tools may perform open-world (externally observable) effects. */
  allowOpenWorld: boolean
}

export const DEFAULT_MCP_TRUST_POLICY: MCPTrustPolicy = {
  trust: "untrusted",
  allowedToolPatterns: [],
  deniedToolPatterns: [],
  defaultRiskLevel: 4,
  allowOpenWorld: false,
}

/** Tool-level hints from MCP annotations — advisory only, never decisive. */
export interface MCPToolHints {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface MCPToolTrustDecision {
  allowed: boolean
  /** Deny reason when not allowed ("denied" | "not_in_allowlist" | null). */
  deniedBy: "denied" | "not_in_allowlist" | null
  readOnly: boolean
  riskLevel: number
  requiresConfirmation: boolean
  allowOpenWorld: boolean
  reason: string
}

/** Simple glob match for tool names: `*` matches any run of characters. */
export function matchesToolPattern(name: string, pattern: string): boolean {
  const p = pattern.trim()
  if (!p || !name) return false
  if (!p.includes("*")) return name === p
  const regex = new RegExp(`^${p.split("*").map(segment => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`)
  return regex.test(name)
}

/** Apply a server trust policy to one tool. Fail-closed on unknown annotations. */
export function evaluateToolTrust(
  policy: MCPTrustPolicy,
  toolName: string,
  hints?: MCPToolHints,
): MCPToolTrustDecision {
  const denied = policy.deniedToolPatterns.some(pattern => matchesToolPattern(toolName, pattern))
  if (denied) {
    return {
      allowed: false,
      deniedBy: "denied",
      readOnly: false,
      riskLevel: policy.defaultRiskLevel,
      requiresConfirmation: true,
      allowOpenWorld: policy.allowOpenWorld,
      reason: `tool denied by MCP trust policy (deniedToolPatterns)`,
    }
  }

  const allowlisted = policy.allowedToolPatterns.length > 0
  const matchesAllowlist = allowlisted
    ? policy.allowedToolPatterns.some(pattern => matchesToolPattern(toolName, pattern))
    : true
  if (!matchesAllowlist) {
    return {
      allowed: false,
      deniedBy: "not_in_allowlist",
      readOnly: false,
      riskLevel: policy.defaultRiskLevel,
      requiresConfirmation: true,
      allowOpenWorld: policy.allowOpenWorld,
      reason: `tool not in MCP trust policy allowlist (allowedToolPatterns)`,
    }
  }

  // Read-only is only ever granted when the server is explicitly trusted AND
  // the tool itself declares readOnlyHint. Everything else defaults to a
  // non-readonly, high-risk surface (annotations are hints, not proof).
  const readOnly = policy.trust === "trusted" && hints?.readOnlyHint === true
  const riskLevel = readOnly ? Math.min(policy.defaultRiskLevel, 1) : policy.defaultRiskLevel
  return {
    allowed: true,
    deniedBy: null,
    readOnly,
    riskLevel,
    requiresConfirmation: !readOnly,
    allowOpenWorld: policy.allowOpenWorld,
    reason: readOnly
      ? `trusted server with explicit readOnlyHint`
      : `untrusted/restricted server or no readOnlyHint — treated as write-capable risk ${riskLevel}`,
  }
}

/** Normalize a partial policy (from config) against defaults. */
export function normalizeTrustPolicy(partial?: Partial<MCPTrustPolicy> | null): MCPTrustPolicy {
  return {
    ...DEFAULT_MCP_TRUST_POLICY,
    ...(partial ?? {}),
  }
}
