/** G2 acceptance: templates compile to validated read-only specs. */

import { describe, expect, test } from "bun:test"
import { buildTemplate, TEMPLATES } from "../../src/workflow/templates/registry"
import { validateSpec } from "../../src/workflow/validation"
import { buildTool, type ContractToolDescriptor } from "../../src/tools/registry"
import { READ_FILE } from "../../src/tools/file"
import { FIND_SYMBOL, FIND_REFERENCES, PROJECT_STRUCTURE } from "../../src/tools/codegraph"
import { GIT_STATUS, GIT_DIFF } from "../../src/tools/git"
import { buildReadonlyRegistry } from "../../src/workflow/registry"

const TOOLS: ContractToolDescriptor[] = [READ_FILE, FIND_SYMBOL, FIND_REFERENCES, PROJECT_STRUCTURE, GIT_STATUS, GIT_DIFF].map(t => buildTool(t))

function validationContext() {
  const registry = buildReadonlyRegistry(TOOLS)
  const handlers = registry.list()
  return {
    knownHandlers: new Set(handlers),
    readonlyHandlers: new Set(handlers),
  }
}

describe("G2 templates", () => {
  test("all templates are registered and documented", () => {
    expect(TEMPLATES.map(t => t.id).sort()).toEqual(["code_explain", "research_report", "security_audit"])
    expect(TEMPLATES.every(t => t.description.length > 0)).toBe(true)
  })

  test("code_explain compiles and validates", () => {
    const spec = buildTemplate("code_explain", { query: "divide", path: "/tmp/x" })
    expect(spec.schemaVersion).toBe("0.1")
    expect(spec.nodes.map(n => n.handler)).toEqual([
      "tool.find_symbol",
      "tool.find_references",
      "tool.read_file",
    ])
    expect(spec.nodes[1]!.dependsOn).toEqual(["t:find"])
    const report = validateSpec(spec, validationContext())
    expect(report.ok).toBe(true)
  })

  test("security_audit fan-out + diagnostics merge", () => {
    const spec = buildTemplate("security_audit", { path: "/tmp/proj", files: ["a.ts", "b.ts"] })
    const handlers = spec.nodes.map(n => n.handler)
    expect(handlers[0]).toBe("tool.project_structure")
    expect(handlers.filter(h => h === "tool.read_file")).toHaveLength(2)
    expect(handlers).toContain("reduce.merge_diagnostics")
    const report = validateSpec(spec, validationContext())
    expect(report.ok).toBe(true)
  })

  test("research_report compiles and validates", () => {
    const spec = buildTemplate("research_report", { path: "/tmp/proj", query: "auth", files: ["src/main.ts"] })
    expect(spec.nodes.map(n => n.handler)).toContain("tool.git_status")
    expect(spec.nodes.map(n => n.handler)).toContain("tool.git_diff")
    expect(spec.nodes.map(n => n.handler)).toContain("tool.find_symbol")
    const report = validateSpec(spec, validationContext())
    expect(report.ok).toBe(true)
  })

  test("stable output for equal inputs", () => {
    expect(buildTemplate("code_explain", { query: "x", path: "/p" }).specId)
      .toBe(buildTemplate("code_explain", { query: "x", path: "/p" }).specId)
  })

  test("unknown template fails loudly", () => {
    expect(() => buildTemplate("no_such", {})).toThrow(/unknown template/)
  })

  test("template nodes never reference write handlers (compile-time read-only)", () => {
    for (const template of TEMPLATES) {
      const spec = buildTemplate(template.id, { path: "/tmp", query: "q", files: ["a.ts"] })
      for (const node of spec.nodes) {
        expect(node.handler).not.toContain("apply_patch")
        expect(node.handler).not.toContain("write")
        expect(node.handler).not.toContain("run_process")
        expect(node.handler).not.toContain("shell")
        expect(node.handler).not.toContain("git_add")
        expect(node.handler).not.toContain("git_commit")
      }
    }
  })
})
