/** G1 acceptance: any write tool is rejected — registration + execution. */

import { describe, expect, test } from "bun:test"
import { buildTool } from "../../src/tools/registry"
import { WRITE_FILE } from "../../src/tools/file"
import { GIT_ADD } from "../../src/tools/git"
import { READ_FILE } from "../../src/tools/file"
import { HandlerRegistry } from "../../src/workflow/execution/handler-registry"
import { runReadonlyTool } from "../../src/workflow/execution/tool-executor"

describe("G1 write protection", () => {
  test("registering a write tool throws", () => {
    const registry = new HandlerRegistry()
    const writeFile = buildTool(WRITE_FILE)
    expect(() => registry.registerTool("tool.write_file", writeFile)).toThrow(/read-only/)
  })

  test("registering a git write tool throws", () => {
    const registry = new HandlerRegistry()
    expect(() => registry.registerTool("tool.git_add", buildTool(GIT_ADD))).toThrow(/read-only/)
  })

  test("execution bridge re-verifies isReadonly (fail-closed)", async () => {
    const writeFile = buildTool(WRITE_FILE)
    const result = await runReadonlyTool("tool:w1", writeFile, { path: "/tmp/g1-blocked.txt", content: "x" })
    expect(result.status).toBe("failed")
    expect(result.error).toContain("blocked")
  })

  test("buildReadonlyRegistry exposes exactly the whitelist", async () => {
    const { buildReadonlyRegistry } = await import("../../src/workflow/registry")
    const { FIND_SYMBOL, FIND_REFERENCES, PROJECT_STRUCTURE } = await import("../../src/tools/codegraph")
    const { GIT_STATUS, GIT_DIFF } = await import("../../src/tools/git")
    const registry = buildReadonlyRegistry([
      buildTool(READ_FILE), buildTool(FIND_SYMBOL), buildTool(FIND_REFERENCES),
      buildTool(PROJECT_STRUCTURE), buildTool(GIT_STATUS), buildTool(GIT_DIFF),
    ])
    const handlers = registry.list().sort()
    expect(handlers).toEqual([
      "reduce.dedupe",
      "reduce.merge_diagnostics",
      "reduce.noop",
      "tool.find_references",
      "tool.find_symbol",
      "tool.git_diff",
      "tool.git_status",
      "tool.project_structure",
      "tool.read_file",
    ])
  })
})
