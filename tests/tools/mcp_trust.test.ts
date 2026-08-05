/** RT-11: MCP trust policy — fail-closed unknown tools, hints are not authority. */

import { describe, expect, test } from "bun:test"
import {
  DEFAULT_MCP_TRUST_POLICY,
  evaluateToolTrust,
  matchesToolPattern,
  normalizeTrustPolicy,
} from "../../src/mcp/trust-policy"

describe("matchesToolPattern (RT-11)", () => {
  test("exact names and * globs", () => {
    expect(matchesToolPattern("git_status", "git_status")).toBe(true)
    expect(matchesToolPattern("git_status", "git_*")).toBe(true)
    expect(matchesToolPattern("read_file", "*_file")).toBe(true)
    expect(matchesToolPattern("read_file", "write_*")).toBe(false)
    expect(matchesToolPattern("mcp_tool", "*")).toBe(true)
    expect(matchesToolPattern("", "*")).toBe(false)
  })
})

describe("evaluateToolTrust (RT-11)", () => {
  test("default posture: unknown tool is non-readonly, high risk, needs confirmation", () => {
    const decision = evaluateToolTrust(DEFAULT_MCP_TRUST_POLICY, "some_tool")
    expect(decision.allowed).toBe(true)
    expect(decision.readOnly).toBe(false)
    expect(decision.riskLevel).toBe(4)
    expect(decision.requiresConfirmation).toBe(true)
    expect(decision.deniedBy).toBe(null)
  })

  test("deniedToolPatterns always win over allowlist and trust", () => {
    const policy = normalizeTrustPolicy({
      trust: "trusted",
      deniedToolPatterns: ["dangerous_*", "rm_*"],
    })
    expect(evaluateToolTrust(policy, "dangerous_exec").allowed).toBe(false)
    expect(evaluateToolTrust(policy, "rm_rf").allowed).toBe(false)
    expect(evaluateToolTrust(policy, "read_file").allowed).toBe(true)
  })

  test("allowlist restricts the exposed surface", () => {
    const policy = normalizeTrustPolicy({ allowedToolPatterns: ["*_read*"] })
    expect(evaluateToolTrust(policy, "search_read").allowed).toBe(true)
    expect(evaluateToolTrust(policy, "execute").allowed).toBe(false)
    expect(evaluateToolTrust(policy, "execute").deniedBy).toBe("not_in_allowlist")
  })

  test("annotations are hints only: trusted + readOnlyHint → read-only low risk", () => {
    const policy = normalizeTrustPolicy({ trust: "trusted" })
    const decision = evaluateToolTrust(policy, "lookup", { readOnlyHint: true })
    expect(decision.readOnly).toBe(true)
    expect(decision.riskLevel).toBe(1)
    expect(decision.requiresConfirmation).toBe(false)
  })

  test("trusted server without readOnlyHint still defaults non-readonly (no blind trust)", () => {
    const policy = normalizeTrustPolicy({ trust: "trusted" })
    const decision = evaluateToolTrust(policy, "mutation", {})
    expect(decision.readOnly).toBe(false)
    expect(decision.requiresConfirmation).toBe(true)
  })

  test("untrusted server with readOnlyHint stays non-readonly (annotation cannot lower risk)", () => {
    const decision = evaluateToolTrust(DEFAULT_MCP_TRUST_POLICY, "sneaky", { readOnlyHint: true })
    expect(decision.readOnly).toBe(false)
    expect(decision.riskLevel).toBe(4)
  })

  test("defaultRiskLevel is honored per server", () => {
    const policy = normalizeTrustPolicy({ trust: "restricted", defaultRiskLevel: 2 })
    const decision = evaluateToolTrust(policy, "tool_x")
    expect(decision.riskLevel).toBe(2)
    expect(decision.requiresConfirmation).toBe(true)
  })

  test("allowOpenWorld flows from policy", () => {
    expect(evaluateToolTrust(DEFAULT_MCP_TRUST_POLICY, "t").allowOpenWorld).toBe(false)
    expect(evaluateToolTrust(normalizeTrustPolicy({ allowOpenWorld: true }), "t").allowOpenWorld).toBe(true)
  })
})
