import { describe, expect, test } from "bun:test"
import { join, resolve } from "node:path"
import { checkWritablePath, checkWritePaths } from "../../src/harness/capabilities/policy/writable-root-policy"
import { isNetworkTool, networkToolBlocked, NETWORK_TOOL_NAMES } from "../../src/harness/capabilities/policy/network-policy"
import { highRiskConfirmationGate, isSessionAllowableRisk } from "../../src/harness/capabilities/policy/risk-policy"
import { approvalDecision } from "../../src/harness/capabilities/policy/approval-policy"
import { checkConcurrency, concurrencyPolicyFor, SERIAL_GROUPS } from "../../src/harness/capabilities/policy/concurrency-policy"
import { buildTools } from "../../src/tools/registry"

// RT-5: policy modules — one shared boundary for every writer, no bypass paths.

describe("RT-5 writable-root policy", () => {
  const root = "/repo"

  test("paths inside the project root are allowed", () => {
    expect(checkWritablePath("src/a.ts", { projectRoot: root })).toEqual({ allowed: true })
    expect(checkWritablePath(resolve(root, "src/a.ts"), { projectRoot: root })).toEqual({ allowed: true })
  })

  test("path traversal outside the root is rejected", () => {
    expect(checkWritablePath("../etc/passwd", { projectRoot: root }).allowed).toBe(false)
    expect(checkWritablePath("src/../../outside.txt", { projectRoot: root }).allowed).toBe(false)
  })

  test("absolute paths outside writable roots are rejected", () => {
    expect(checkWritablePath("/etc/hosts", { projectRoot: root }).allowed).toBe(false)
  })

  test("custom writable roots extend the boundary", () => {
    expect(checkWritablePath("/tmp/work/x.ts", { projectRoot: root, writableRoots: [join(root, "out"), "/tmp/work"] }).allowed).toBe(true)
    expect(checkWritablePath("/tmp/other/y.ts", { projectRoot: root, writableRoots: [join(root, "out"), "/tmp/work"] }).allowed).toBe(false)
  })

  test("checkWritePaths extracts declarative path keys", () => {
    expect(checkWritePaths({ path: "a.ts" }, { projectRoot: root })).toEqual({ allowed: true })
    const bad = checkWritePaths({ file: "../escape" }, { projectRoot: root })
    expect(bad!.allowed).toBe(false)
    // No path keys → null (readers/commands pass through).
    expect(checkWritePaths({ content: "x" }, { projectRoot: root })).toBeNull()
  })
})

describe("RT-5 network policy", () => {
  test("network tool set is declared", () => {
    expect(NETWORK_TOOL_NAMES).toEqual(["web_fetch", "web_search", "exa_web_search_exa"])
    expect(isNetworkTool("web_fetch")).toBe(true)
    expect(isNetworkTool("read_file")).toBe(false)
  })

  test("failed web search blocks only web_search", () => {
    expect(networkToolBlocked("web_search", true, "docker down")).not.toBeNull()
    expect(networkToolBlocked("web_search", false, "")).toBeNull()
    expect(networkToolBlocked("web_fetch", true, "docker down")).toBeNull()
  })
})

describe("RT-5 approval policy", () => {
  test("deny always blocks; allow always passes", () => {
    expect(approvalDecision({ gateLevel: "deny", permissionMode: "full", riskLevel: 1 }).allowed).toBe(false)
    expect(approvalDecision({ gateLevel: "allow", permissionMode: "strict", riskLevel: 5 }).allowed).toBe(true)
  })

  test("strict mode hard-blocks ask (fail closed, no interactive channel)", () => {
    expect(approvalDecision({ gateLevel: "ask", permissionMode: "strict", riskLevel: 0 }).allowed).toBe(false)
  })

  test("full mode promotes ask — the risk gate owns Risk 4-5 (gate order preserved)", () => {
    expect(approvalDecision({ gateLevel: "ask", permissionMode: "full", riskLevel: 3 }).allowed).toBe(true)
    // Promotion happens here; high-risk rejection is the risk gate's job
    // (priority 8, fires last so specific gates win their reasons).
    expect(approvalDecision({ gateLevel: "ask", permissionMode: "full", riskLevel: 4 }).allowed).toBe(true)
    expect(approvalDecision({ gateLevel: "ask", permissionMode: "full", riskLevel: 5 }).allowed).toBe(true)
  })

  test("Risk 4-5 is never session-wide allowable", () => {
    expect(isSessionAllowableRisk(3)).toBe(true)
    expect(isSessionAllowableRisk(4)).toBe(false)
    expect(isSessionAllowableRisk(5)).toBe(false)
  })
})

describe("RT-5 risk policy", () => {
  /** Unknown write tools are conservatively treated as high risk (Risk 4). */
  function unknownWriteTool() {
    return buildTools({
      name: "unknown_writer",
      description: "x",
      isReadonly: false,
      inputSchema: { type: "object", properties: {}, required: [] },
      execute: () => ({ success: true, content: "ok" }),
    })[0]!
  }

  function readonlyTool() {
    return buildTools({
      name: "safe_reader",
      description: "x",
      isReadonly: true,
      inputSchema: { type: "object", properties: {}, required: [] },
      execute: () => ({ success: true, content: "ok" }),
    })[0]!
  }

  test("unknown write tools require per-invocation confirmation in full mode", () => {
    const gate = highRiskConfirmationGate(unknownWriteTool(), {}, "full")
    expect(gate).not.toBeNull()
    expect(gate!.reason).toBe("tool_risk:4")
    expect(gate!.priority).toBe(8)
  })

  test("strict mode never reaches the risk gate (ask hard-blocks earlier)", () => {
    expect(highRiskConfirmationGate(unknownWriteTool(), {}, "strict")).toBeNull()
  })

  test("readonly tools pass the gate", () => {
    expect(highRiskConfirmationGate(readonlyTool(), {}, "full")).toBeNull()
  })
})

describe("RT-5 concurrency policy", () => {
  test("writes and external actions serialize by default", () => {
    expect(SERIAL_GROUPS.has("write")).toBe(true)
    expect(SERIAL_GROUPS.has("external")).toBe(true)
    expect(concurrencyPolicyFor("write").maxConcurrent).toBe(1)
    expect(concurrencyPolicyFor("read").maxConcurrent).toBe(Number.MAX_SAFE_INTEGER)
  })

  test("declared caps are honored", () => {
    expect(checkConcurrency("lsp", 2, 2).allowed).toBe(false)
    expect(checkConcurrency("lsp", 1, 2).allowed).toBe(true)
    expect(checkConcurrency("write", 1).allowed).toBe(false)
  })
})
