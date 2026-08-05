import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildRepoMap, queryRepoMap } from "../../src/tools/repo-map"
import { BUILD_REPO_MAP_TOOL, BUILD_CONTEXT_SLICE_TOOL } from "../../src/tools/repo-map"

// RT-9: repo map — compiler-AST symbol extraction, import edges, related
// tests, token estimate; never returns raw repo content.

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "rt9-"))
  mkdirSync(join(dir, "src"), { recursive: true })
  writeFileSync(join(dir, "src", "api.ts"), [
    "export function fetchUser(id: string): string {",
    "  return `user-${id}`",
    "}",
    "export const DEFAULT_LIMIT = 10",
  ].join("\n"))
  writeFileSync(join(dir, "src", "main.ts"), [
    "import { fetchUser } from './api'",
    "export function run(): string {",
    "  return fetchUser('1')",
    "}",
  ].join("\n"))
  writeFileSync(join(dir, "src", "api.test.ts"), "import { fetchUser } from './api'\n")
  return dir
}

describe("RT-9 buildRepoMap", () => {
  test("extracts symbols with authority + confidence and import edges", () => {
    const dir = makeProject()
    try {
      const map = buildRepoMap({ projectRoot: dir })
      expect(map.scannedFiles).toBe(3)
      expect(map.provenance).toBe("compiler")
      expect(map.rankedSymbols.length).toBeGreaterThanOrEqual(3)

      const names = map.rankedSymbols.map((s) => s.name)
      expect(names).toContain("fetchUser")
      expect(names).toContain("run")
      expect(names).toContain("DEFAULT_LIMIT")

      const fetchUser = map.rankedSymbols.find((s) => s.name === "fetchUser")!
      expect(fetchUser.authority).toBe("ast")
      expect(fetchUser.confidence).toBeGreaterThan(0.9)
      expect(fetchUser.kind).toBe("function")

      expect(map.dependencyEdges.some((e) => e.from === "src/main.ts" && e.to === "./api")).toBe(true)
      expect(map.relatedTests.some((t) => t.includes("api.test.ts"))).toBe(true)
      expect(map.tokenEstimate).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("entryFile anchors entrypoints", () => {
    const dir = makeProject()
    try {
      const map = buildRepoMap({ projectRoot: dir, entryFile: "src/main.ts" })
      expect(map.entrypoints).toEqual(["src/main.ts"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("RT-9 queryRepoMap", () => {
  test("finds symbols by name with locations", () => {
    const dir = makeProject()
    try {
      const matches = queryRepoMap({ projectRoot: dir, query: "fetchUser" })
      expect(matches.length).toBe(1)
      expect(matches[0]!.file).toBe("src/api.ts")
      expect(matches[0]!.kind).toBe("function")
      expect(matches[0]!.authority).toBe("ast")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("empty query returns nothing", () => {
    const dir = makeProject()
    try {
      expect(queryRepoMap({ projectRoot: dir, query: "no-such-symbol-xyz" })).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("RT-9 tools", () => {
  test("build_repo_map tool returns summary + structured map", async () => {
    const dir = makeProject()
    try {
      const result = await BUILD_REPO_MAP_TOOL.execute!({ cwd: dir })
      expect(result.success).toBe(true)
      expect(result.content).toContain("scanned 3 TS file(s)")
      expect(result.content).toContain("provenance: compiler")
      const map = (result.metadata as { map: { entrypoints: string[]; rankedSymbols: unknown[] } }).map
      expect(map.entrypoints.length).toBeGreaterThan(0)
      expect(map.rankedSymbols.length).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("build_context_slice returns entry + imports within budget", async () => {
    const dir = makeProject()
    try {
      const result = await BUILD_CONTEXT_SLICE_TOOL.execute!({ entryFile: "src/main.ts", cwd: dir, tokenBudget: 8000 })
      expect(result.success).toBe(true)
      expect(result.content).toContain("src/main.ts")
      expect(result.content).toContain("src/api.ts") // imported by main
      const meta = result.metadata as { files: string[]; usedTokens: number; budget: number }
      expect(meta.files).toContain("src/main.ts")
      expect(meta.files).toContain("src/api.ts")
      expect(meta.usedTokens).toBeLessThanOrEqual(8000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("context slice fails on missing entry file", async () => {
    const dir = makeProject()
    try {
      const result = await BUILD_CONTEXT_SLICE_TOOL.execute!({ entryFile: "nope.ts", cwd: dir })
      expect(result.success).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
