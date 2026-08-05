/** G6 acceptance: dynamic compiler — registered types/handlers only,
 *  no arbitrary code, five-validator contract, write safety (PR-G6). */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { buildTool, type ContractToolDescriptor } from "../../src/tools/registry"
import { FIND_SYMBOL, FIND_REFERENCES, PROJECT_STRUCTURE } from "../../src/tools/codegraph"
import { GIT_STATUS, GIT_DIFF } from "../../src/tools/git"
import { RUN_PROCESS_TOOL } from "../../src/tools/process"
import { RUN_TARGETED_VERIFICATION_TOOL } from "../../src/tools/verification"
import { READ_FILE } from "../../src/tools/file"
import { APPLY_PATCH_TRANSACTION_TOOL } from "../../src/tools/apply-patch"
import { buildReadWriteRegistry } from "../../src/workflow/registry"
import { compileDynamicSpec } from "../../src/workflow/dynamic/dynamic-compiler"
import { parseDynamicSpec } from "../../src/workflow/dynamic/dynamic-schema"

const PROJECT = resolve("tmp-g6-dyn")

beforeAll(() => {
  mkdirSync(PROJECT, { recursive: true })
  writeFileSync(join(PROJECT, "a.ts"), "export const a = 1\n")
})

afterAll(() => {
  rmSync(PROJECT, { recursive: true, force: true })
})

function tools(): ContractToolDescriptor[] {
  return [
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
}

function registry() {
  return buildReadWriteRegistry(tools())
}

const GOOD_GRAPH = {
  schemaVersion: "0.1",
  specId: "dyn-good",
  mode: "read-write",
  maxParallel: 2,
  nodes: [
    { id: "r:locate", type: "read", handler: "tool.find_symbol", input: { query: "add" }, dependsOn: [] },
    { id: "w:patch", type: "write", handler: "tool.apply_patch", input: { patches: [] }, dependsOn: ["r:locate"] },
    { id: "v:verify", type: "verify", handler: "tool.run_targeted_verification", input: { files: [] }, dependsOn: ["w:patch"] },
  ],
}

describe("G6 dynamic compiler", () => {
  test("valid read-write graph compiles to a shared-scheduler spec", () => {
    const result = compileDynamicSpec(GOOD_GRAPH, { registry: registry() })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.spec.schemaVersion).toBe("0.1")
      expect(result.spec.mode).toBe("read-write")
      expect(result.spec.nodes).toHaveLength(3)
      expect(result.spec.nodes[2]!.dependsOn).toEqual(["w:patch"])
    }
  })

  test("unknown handler is rejected", () => {
    const evil = {
      ...GOOD_GRAPH,
      specId: "dyn-evil",
      nodes: [{ id: "r:locate", handler: "tool.eval_arbitrary_code", input: {}, dependsOn: [] }],
    }
    const result = compileDynamicSpec(evil, { registry: registry() })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some(i => i.code === "unknown_handler")).toBe(true)
    }
  })

  test("write handler in read-only mode is rejected", () => {
    const graph = { ...GOOD_GRAPH, specId: "dyn-ro", mode: "readonly" }
    const result = compileDynamicSpec(graph, { registry: registry() })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some(i => i.code === "write_handler")).toBe(true)
    }
  })

  test("node type must agree with its handler family", () => {
    const bad = {
      ...GOOD_GRAPH,
      specId: "dyn-type",
      nodes: [{ id: "r:locate", type: "read", handler: "tool.apply_patch", input: {}, dependsOn: [] }],
    }
    const result = compileDynamicSpec(bad, { registry: registry() })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some(i => i.code === "type_mismatch")).toBe(true)
    }
  })

  test("unknown node type is rejected at parse time (whitelist)", () => {
    const bad = {
      ...GOOD_GRAPH,
      specId: "dyn-ntype",
      nodes: [{ id: "n", type: "delegate_to_shell", handler: "tool.read_file", input: {}, dependsOn: [] }],
    }
    const result = compileDynamicSpec(bad, { registry: registry() })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues[0]!.code).toBe("parse_error")
      expect(result.issues[0]!.message).toContain("type")
    }
  })

  test("invalid write concurrency is rejected (maxParallel < 1, write cycle)", () => {
    const badParallel = { ...GOOD_GRAPH, specId: "dyn-para", maxParallel: 0 }
    expect(compileDynamicSpec(badParallel, { registry: registry() }).ok).toBe(false)

    const cycle = {
      ...GOOD_GRAPH,
      specId: "dyn-cycle",
      nodes: [
        { id: "w1", type: "write", handler: "tool.apply_patch", input: { patches: [] }, dependsOn: ["w2"] },
        { id: "w2", type: "write", handler: "tool.apply_patch", input: { patches: [] }, dependsOn: ["w1"] },
        { id: "v:verify", type: "verify", handler: "tool.run_targeted_verification", input: { files: [] }, dependsOn: ["w1", "w2"] },
      ],
    }
    const result = compileDynamicSpec(cycle, { registry: registry() })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some(i => i.code === "cycle")).toBe(true)
    }
  })

  test("write nodes without verification: rejected by default, auto-appended on demand", () => {
    const unverified = {
      ...GOOD_GRAPH,
      specId: "dyn-nover",
      nodes: [GOOD_GRAPH.nodes[0]!, GOOD_GRAPH.nodes[1]!],
    }
    expect(compileDynamicSpec(unverified, { registry: registry() }).ok).toBe(false)

    const appended = compileDynamicSpec(unverified, { registry: registry(), autoAppendVerification: true })
    expect(appended.ok).toBe(true)
    if (appended.ok) {
      expect(appended.spec.nodes.some(n => n.handler === "tool.run_targeted_verification")).toBe(true)
      expect(appended.warnings.some(w => w.startsWith("appended verification"))).toBe(true)
    }
  })

  test("write budget caps the number of write nodes", () => {
    const two = {
      ...GOOD_GRAPH,
      specId: "dyn-2w",
      nodes: [
        GOOD_GRAPH.nodes[0]!,
        GOOD_GRAPH.nodes[1]!,
        { ...GOOD_GRAPH.nodes[1]!, id: "w2:patch", dependsOn: ["r:locate"] },
        { ...GOOD_GRAPH.nodes[2]!, dependsOn: ["w:patch", "w2:patch"] },
      ],
    }
    const result = compileDynamicSpec(two, { registry: registry(), maxWrites: 1 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some(i => i.code === "too_many_writes")).toBe(true)
    }
  })

  test("arbitrary code / non-JSON payloads are structurally rejected", () => {
    expect(compileDynamicSpec("function x() { return 1 }", { registry: registry() }).ok).toBe(false)
    expect(compileDynamicSpec(42, { registry: registry() }).ok).toBe(false)
    expect(compileDynamicSpec(null, { registry: registry() }).ok).toBe(false)
    expect(compileDynamicSpec({ schemaVersion: "0.2", specId: "x", nodes: [] }, { registry: registry() }).ok).toBe(false)
    expect(compileDynamicSpec({ ...GOOD_GRAPH, specId: "x", nodes: [{ id: 1 }] }, { registry: registry() }).ok).toBe(false)
    expect(parseDynamicSpec("not json {").ok).toBe(false)
    expect(parseDynamicSpec("{}").ok).toBe(false)
  })
})
