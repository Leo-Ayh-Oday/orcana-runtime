/** G3 acceptance: narrow_fix / test_repair write templates. */

import { describe, expect, test } from "bun:test"
import { buildNarrowFix, buildTestRepair } from "../../src/workflow/templates/write-templates"
import { validateSpec } from "../../src/workflow/validation"
import { buildTool } from "../../src/tools/registry"
import { READ_FILE } from "../../src/tools/file"
import { FIND_SYMBOL, FIND_REFERENCES, PROJECT_STRUCTURE } from "../../src/tools/codegraph"
import { GIT_STATUS, GIT_DIFF } from "../../src/tools/git"
import { APPLY_PATCH_TRANSACTION_TOOL } from "../../src/tools/apply-patch"
import { RUN_PROCESS_TOOL } from "../../src/tools/process"
import { RUN_TARGETED_VERIFICATION_TOOL } from "../../src/tools/verification"
import { buildReadWriteRegistry, buildReadonlyRegistry } from "../../src/workflow/registry"

describe("G3 write templates", () => {
  const tools = [
    buildTool(READ_FILE),
    buildTool(FIND_SYMBOL),
    buildTool(FIND_REFERENCES),
    buildTool(PROJECT_STRUCTURE),
    buildTool(GIT_STATUS),
    buildTool(GIT_DIFF),
    buildTool(APPLY_PATCH_TRANSACTION_TOOL),
    buildTool(RUN_PROCESS_TOOL),
    buildTool(RUN_TARGETED_VERIFICATION_TOOL),
  ]

  test("narrow_fix: locate → read → patch → verify, read-write mode", () => {
    const spec = buildNarrowFix({ query: "add", path: "/tmp/p", files: ["src/calc.ts"], diff: "--- a/src/calc.ts\n+++ b/src/calc.ts\n@@ -1 +1 @@\n-a\n+b\n" })
    expect(spec.mode).toBe("read-write")
    const handlers = spec.nodes.map(n => n.handler)
    expect(handlers[0]).toBe("tool.find_symbol")
    expect(handlers[1]).toBe("tool.read_file")
    expect(handlers[2]).toBe("tool.apply_patch")
    expect(handlers[3]).toBe("tool.run_targeted_verification")
    // write → verify structure: the verification node depends on the write node.
    expect(spec.nodes[3]!.dependsOn).toEqual(["w:patch"])
    // stable spec id
    expect(spec.specId).toBe(buildNarrowFix({ query: "add", path: "/tmp/p", files: ["src/calc.ts"], diff: "--- a/src/calc.ts\n+++ b/src/calc.ts\n@@ -1 +1 @@\n-a\n+b\n" }).specId)
  })

  test("test_repair: run tests → read → patch → verify", () => {
    const spec = buildTestRepair({ path: "/tmp/p", files: ["src/b.ts"], diff: "x" })
    expect(spec.mode).toBe("read-write")
    expect(spec.nodes[0]!.handler).toBe("tool.run_process")
    expect(spec.nodes[1]!.handler).toBe("tool.read_file")
    expect(spec.nodes[2]!.handler).toBe("tool.apply_patch")
    expect(spec.nodes[3]!.handler).toBe("tool.run_targeted_verification")
    expect(spec.nodes[3]!.dependsOn).toEqual(["t:patch"])
  })

  test("write templates validate against the read-write registry context", () => {
    const registry = buildReadWriteRegistry(tools)
    const ctx = {
      knownHandlers: new Set(registry.list()),
      readonlyHandlers: new Set(buildReadonlyRegistry(tools).list()),
      handlerInputKind: Object.fromEntries(registry.list().map(h => [h, "object" as const])),
    }
    const report = validateSpec(buildNarrowFix({ query: "q", files: ["a.ts"], diff: "d" }), ctx)
    expect(report.ok).toBe(true)
  })

  test("write templates are rejected in read-only validation context", () => {
    const readonly = buildReadonlyRegistry([
      buildTool(READ_FILE), buildTool(FIND_SYMBOL), buildTool(FIND_REFERENCES),
      buildTool(PROJECT_STRUCTURE), buildTool(GIT_STATUS), buildTool(GIT_DIFF),
    ])
    const ctx = {
      knownHandlers: new Set(readonly.list()),
      readonlyHandlers: new Set(readonly.list()),
    }
    const report = validateSpec(buildNarrowFix({ query: "q", files: ["a.ts"], diff: "d" }), ctx)
    expect(report.ok).toBe(false)
    // In a read-only registry the write handlers are simply not registered.
    expect(report.issues.some(i => i.code === "unknown_handler")).toBe(true)
  })
})
