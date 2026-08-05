/** RT-12: Capability Router — layered disclosure, stable order, schema economy. */

import { describe, expect, test } from "bun:test"
import type { ToolDef } from "../../src/tools/registry"
import { BUILTIN_TOOL_DEFS } from "../../src/tools/builtins"
import {
  STABLE_CORE_TOOL_NAMES,
  routeCapabilities,
  selectToolDefs,
  estimateToolTokens,
} from "../../src/harness/capabilities/router"

function names(tools: ToolDef[]): string[] {
  return tools.map(t => t.name)
}

describe("routeCapabilities (RT-12)", () => {
  const options = { tools: [...BUILTIN_TOOL_DEFS] }

  test("every profile discloses the full stable core in fixed order", () => {
    const types = ["coding", "code_intelligence", "verification", "git_ops", "web_research", "service_ops", "reasoning"] as const
    for (const type of types) {
      const decision = routeCapabilities({ type }, options)
      const core = decision.capabilityIds.slice(0, STABLE_CORE_TOOL_NAMES.length)
      expect(core).toEqual([...STABLE_CORE_TOOL_NAMES])
      expect(decision.reason).toContain("stable core")
    }
  })

  test("stable prefix is byte-stable across profiles", () => {
    const a = routeCapabilities({ type: "web_research" }, options)
    const b = routeCapabilities({ type: "reasoning" }, options)
    const prefixLen = STABLE_CORE_TOOL_NAMES.length
    expect(a.capabilityIds.slice(0, prefixLen)).toEqual(b.capabilityIds.slice(0, prefixLen))
    const joinedA = JSON.stringify(a.capabilityIds.slice(0, prefixLen))
    const joinedB = JSON.stringify(b.capabilityIds.slice(0, prefixLen))
    expect(joinedA).toBe(joinedB)
  })

  test("simple reasoning task does not load web/mcp/service/lsp (TL-017)", () => {
    const decision = routeCapabilities({ type: "reasoning" }, options)
    expect(decision.capabilityIds).not.toContain("web_search")
    expect(decision.capabilityIds).not.toContain("web_fetch")
    expect(decision.capabilityIds).not.toContain("lsp_diagnostics")
    expect(decision.capabilityIds).not.toContain("build_repo_map")
    expect(decision.capabilityIds).not.toContain("service_start")
    // …and those are listed as fallback for on-demand disclosure
    expect(decision.fallback).toContain("web_search")
    expect(decision.fallback).toContain("service_start")
    expect(decision.fallback).toContain("lsp_diagnostics")
  })

  test("web_research adds web tools only", () => {
    const decision = routeCapabilities({ type: "web_research" }, options)
    expect(decision.capabilityIds).toContain("web_search")
    expect(decision.capabilityIds).toContain("web_fetch")
    expect(decision.capabilityIds).not.toContain("build_repo_map")
    expect(decision.capabilityIds).not.toContain("service_start")
  })

  test("service_ops adds service tools only", () => {
    const decision = routeCapabilities({ type: "service_ops" }, options)
    expect(decision.capabilityIds).toContain("service_start")
    expect(decision.capabilityIds).toContain("service_stop")
    expect(decision.capabilityIds).not.toContain("web_fetch")
  })

  test("code_intelligence adds LSP/repo-map specialists", () => {
    const decision = routeCapabilities({ type: "code_intelligence" }, options)
    expect(decision.capabilityIds).toContain("find_symbol")
    expect(decision.capabilityIds).toContain("build_repo_map")
    expect(decision.capabilityIds).not.toContain("web_fetch")
  })

  test("verification adds the verification toolchain", () => {
    const decision = routeCapabilities({ type: "verification" }, options)
    expect(decision.capabilityIds).toContain("discover_verification")
    expect(decision.capabilityIds).toContain("run_targeted_verification")
    expect(decision.capabilityIds).toContain("classify_command_failure")
  })

  test("coding adds code intelligence + verification, defers web/service", () => {
    const decision = routeCapabilities({ type: "coding", language: "typescript" }, options)
    expect(decision.capabilityIds).toContain("find_symbol")
    expect(decision.capabilityIds).toContain("discover_verification")
    expect(decision.capabilityIds).not.toContain("web_search")
    expect(decision.capabilityIds).not.toContain("service_start")
    expect(decision.reason).toContain("language=typescript")
  })

  test("small context budget collapses to stable core + meta (schema economy)", () => {
    const decision = routeCapabilities({ type: "web_research", contextBudgetTokens: 1500 }, options)
    expect(decision.capabilityIds).not.toContain("web_search")
    expect(decision.reason).toContain("context budget")
    expect(decision.fallback).toContain("web_search")
  })

  test("meta tools are always present (session cannot dead-end)", () => {
    for (const type of ["reasoning", "web_research", "coding"] as const) {
      const decision = routeCapabilities({ type }, options)
      expect(decision.capabilityIds).toContain("ask_user")
      expect(decision.capabilityIds).toContain("todo_write")
      expect(decision.capabilityIds).toContain("task")
    }
  })

  test("reasoning profile discloses fewer tokens than web_research", () => {
    const reasoning = routeCapabilities({ type: "reasoning" }, options)
    const web = routeCapabilities({ type: "web_research" }, options)
    expect(reasoning.tokenEstimate).toBeLessThan(web.tokenEstimate)
    expect(estimateToolTokens(BUILTIN_TOOL_DEFS.find(t => t.name === "web_fetch")!)).toBeGreaterThan(0)
  })

  test("selectToolDefs returns the disclosed subset in router order", () => {
    const { tools, decision } = selectToolDefs({ type: "web_research" }, [...BUILTIN_TOOL_DEFS])
    expect(names(tools)).toEqual(decision.capabilityIds)
    expect(tools.length).toBeLessThan(BUILTIN_TOOL_DEFS.length)
    expect(names(tools)[0]).toBe("read_file")
    // meta tools close the disclosure in stable order
    expect(names(tools).slice(-3)).toEqual(["ask_user", "todo_write", "task"])
  })
})
