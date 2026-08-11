import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildContextMap,
  buildSourceUnderstanding,
  attachContextMapToTaskPacket,
  contextEvidenceForMap,
  evaluateContextReadiness,
  formatContextMapSummary,
  hybridLocate,
  loadContextMap,
  loadProjectConstitution,
  saveContextMap,
  scanRepoStructure,
  selectContextMapTaskLevel,
} from "../src/context/context-map"
import { ensureContextMemoryLayout } from "../src/memory/context-memory-os"
import { buildPacketFromLine } from "../src/agent/task-packet"
import { createWorkspaceIoAuthority } from "../src/runtime/io/workspace-io-authority"
import type { WorkspaceIoAuthority } from "../src/runtime/io/workspace-io-authority"

/** IC01-R3: 直接 API 必须显式传入 WorkspaceIoAuthority（无权威时 fail closed）。 */
function wsFor(root: string): WorkspaceIoAuthority {
  return createWorkspaceIoAuthority(root)
}

function createRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "orcana-context-map-"))
  mkdirSync(join(root, "src", "agent"), { recursive: true })
  mkdirSync(join(root, "tests"), { recursive: true })
  mkdirSync(join(root, ".github", "workflows"), { recursive: true })
  ensureContextMemoryLayout(root)
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "fixture",
    main: "dist/src/index.js",
    bin: { fixture: "bin/fixture.cjs" },
    scripts: {
      typecheck: "tsc --noEmit",
      test: "bun test",
      build: "tsc -p tsconfig.build.json",
    },
  }, null, 2), "utf-8")
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }), "utf-8")
  writeFileSync(join(root, "bun.lock"), "", "utf-8")
  writeFileSync(join(root, "ARCHITECTURE.md"), [
    "# Runtime",
    "- Agent runtime must keep TaskPacket and Evidence across context rollover.",
    "- Do not bypass completion evidence gates.",
    "- Known risk: large files need narrower symbol reads.",
  ].join("\n"), "utf-8")
  writeFileSync(join(root, "src", "index.ts"), "export { evaluateCompletionGate } from './agent/completion-gate'\n", "utf-8")
  writeFileSync(join(root, "src", "agent", "completion-gate.ts"), [
    "export interface CompletionInput { evidence: string[] }",
    "export function evaluateCompletionGate(input: CompletionInput): boolean {",
    "  return input.evidence.length > 0",
    "}",
  ].join("\n"), "utf-8")
  writeFileSync(join(root, "tests", "completion-gate.test.ts"), [
    "import { describe, expect, test } from 'bun:test'",
    "import { evaluateCompletionGate } from '../src/agent/completion-gate'",
    "describe('completion evidence', () => {",
    "  test('requires evidence', () => {",
    "    expect(evaluateCompletionGate({ evidence: ['typecheck'] })).toBe(true)",
    "  })",
    "})",
  ].join("\n"), "utf-8")
  return root
}

describe("Context Map Pipeline", () => {
  test("IC01 #9: giant README 只读 cap，不完整读入（ContextMap 合理降级）", () => {
    const root = createRepo()
    try {
      const giant = [
        "# Runtime",
        "- Agent runtime must keep evidence across rollover.",
      ].join("\n") + "\n" + "x".repeat(512 * 1024) + "\ntail sentinel MUST NOT appear in rules\n"
      writeFileSync(join(root, "README.md"), giant, "utf-8")

      const constitution = loadProjectConstitution(root, { workspace: wsFor(root) })
      // 正常返回（合理降级，不崩溃）。
      expect(constitution.importantFiles).toContain("README.md")
      // 头部内容（cap 之内）正常进入 notes。
      expect(constitution.architectureNotes.some(n => n.includes("runtime must keep evidence"))).toBe(true)
      // 尾部哨兵行（超出 20_000 字节 cap）不得进入任何分类结果 ——
      // 证明只读取前缀，没有完整读入。
      const all = constitution.architectureNotes.concat(constitution.codingRules, constitution.forbiddenActions).join("\n")
      expect(all).not.toContain("tail sentinel MUST NOT appear")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("IC01 #9: giant bun.lock 只读 cap，不完整读入", () => {
    const root = createRepo()
    try {
      const giant = "x".repeat(512 * 1024) + "\nlockfile tail sentinel MUST NOT appear\n"
      writeFileSync(join(root, "bun.lock"), giant, "utf-8")

      const constitution = loadProjectConstitution(root, { workspace: wsFor(root) })
      expect(constitution.importantFiles).toContain("bun.lock")
      const all = constitution.architectureNotes.concat(constitution.codingRules, constitution.forbiddenActions).join("\n")
      expect(all).not.toContain("lockfile tail sentinel")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("loads project constitution from docs, memory index, and package scripts", () => {
    const root = createRepo()
    try {
      const constitution = loadProjectConstitution(root, { workspace: wsFor(root) })

      expect(constitution.importantFiles).toContain("ARCHITECTURE.md")
      expect(constitution.importantFiles).toContain("package.json")
      expect(constitution.architectureNotes.some(note => note.includes("TaskPacket"))).toBe(true)
      expect(constitution.forbiddenActions.some(rule => rule.includes("bypass completion evidence"))).toBe(true)
      expect(constitution.buildCommands).toContain("typecheck: tsc --noEmit")
      expect(constitution.testCommands).toContain("test: bun test")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("scans repo structure and infers package manager, roots, entrypoints, and modules", () => {
    const root = createRepo()
    try {
      const structure = scanRepoStructure(root, { workspace: wsFor(root) })

      expect(structure.packageManager).toBe("bun")
      expect(structure.sourceRoots).toContain("src")
      expect(structure.testRoots).toContain("tests")
      expect(structure.configFiles).toContain("package.json")
      expect(structure.entrypoints).toContain("dist/src/index.js")
      expect(structure.moduleHints.some(hint => hint.path === "src/agent" && hint.purpose === "agent runtime")).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("hybrid locator finds primary source files, symbols, references, and tests", () => {
    const root = createRepo()
    try {
      const located = hybridLocate(root, {
        userRequest: "fix evaluateCompletionGate completion evidence",
      }, { workspace: wsFor(root) })

      expect(located.primaryFiles).toContain("src/agent/completion-gate.ts")
      expect(located.suspectedTests).toContain("tests/completion-gate.test.ts")
      expect(located.relevantSymbols).toContain("evaluateCompletionGate")
      expect(located.definitions.some(def => def.symbol === "evaluateCompletionGate")).toBe(true)
      expect(located.references.some(ref => ref.file === "tests/completion-gate.test.ts")).toBe(true)
      expect(located.confidence).toBeGreaterThanOrEqual(0.6)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("source understanding records read files, notes, invariants, and edit targets", () => {
    const root = createRepo()
    try {
      const understanding = buildSourceUnderstanding(root, [
        "src/agent/completion-gate.ts",
        "tests/completion-gate.test.ts",
      ], { workspace: wsFor(root) })

      expect(understanding.filesRead).toEqual([
        "src/agent/completion-gate.ts",
        "tests/completion-gate.test.ts",
      ])
      expect(understanding.dataFlowNotes[0]?.summary).toContain("exports")
      expect(understanding.invariants.some(item => item.includes("completion-gate.ts"))).toBe(true)
      expect(understanding.likelyEditTargets.some(target => target.file === "tests/completion-gate.test.ts")).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("builds, stores, loads, and evaluates a context map", () => {
    const root = createRepo()
    try {
      const map = buildContextMap(root, {
        taskId: "task-context-map",
        userRequest: "fix evaluateCompletionGate completion evidence handling",
      }, { workspace: wsFor(root) })
      const readiness = evaluateContextReadiness(map, "long")
      const stored = saveContextMap(root, map)
      const loaded = loadContextMap(root, map.id, { workspace: wsFor(root) })

      expect(map.id).toMatch(/^ctx-[a-f0-9]{12}$/)
      expect(readiness.blockers).toEqual([])
      expect(readiness.hasProjectConstitution).toBe(true)
      expect(readiness.hasLocateResult).toBe(true)
      expect(readiness.hasSourceUnderstanding).toBe(true)
      expect(readiness.hasVerificationPlan).toBe(true)
      expect(existsSync(stored)).toBe(true)
      expect(loaded?.id).toBe(map.id)
      expect(formatContextMapSummary(map)).toContain("primaryFiles:")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("attaches context map identity and evidence to TaskPacket", () => {
    const root = createRepo()
    try {
      const map = buildContextMap(root, {
        taskId: "task-context-map",
        userRequest: "fix evaluateCompletionGate completion evidence handling",
      }, { workspace: wsFor(root) })
      const packet = buildPacketFromLine({
        title: "Update src/agent/completion-gate.ts and run tests",
        goal: "fix completion evidence",
        nodeId: "node-1",
        taskId: "task-context-map",
      })
      const attached = attachContextMapToTaskPacket(packet, map)

      expect(attached.contextMapId).toBe(map.id)
      expect(attached.requiredContextEvidence).toEqual(contextEvidenceForMap(map))
      expect(attached.requiredContextEvidence?.some(item => item.startsWith("locateResult:"))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("selects context map task levels from risk, request shape, and touched file count", () => {
    expect(selectContextMapTaskLevel({ userRequest: "hello" })).toBe("small")
    expect(selectContextMapTaskLevel({ userRequest: "fix completion bug" })).toBe("medium")
    expect(selectContextMapTaskLevel({ userRequest: "refactor runtime architecture" })).toBe("long")
    expect(selectContextMapTaskLevel({ userRequest: "small text", touchedFiles: 4 })).toBe("long")
    expect(selectContextMapTaskLevel({ userRequest: "edit sandbox", risk: "high" })).toBe("high_risk")
  })

  test("readiness blocks high-risk tasks when confidence is too low", () => {
    const root = createRepo()
    try {
      const map = buildContextMap(root, {
        taskId: "task-unknown",
        userRequest: "change totally unmatched subsystem",
        keywords: ["zzzz-unmatched"],
      }, { workspace: wsFor(root) })
      const readiness = evaluateContextReadiness(map, "high_risk")

      expect(readiness.blockers).toContain("High-risk task confidence below 0.75.")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── IC01-R5: 全部 ContextMap 导出入口 —— 无 authority 零探测、零 oracle ──

describe("IC01-R5 全部导出入口 fail-closed —— 存在/不存在路径不可区分", () => {
  const existRoot = createRepo()
  const emptyRoot = mkdtempSync(join(tmpdir(), "orcana-ctx-r5-empty-"))
  const archiveId = "ctx-000000000001"

  beforeAll(() => {
    // 存在 fixture：源文件 + 元数据 + secret + 归档。
    mkdirSync(join(existRoot, "src"), { recursive: true })
    writeFileSync(join(existRoot, "src", "index.ts"), "export const indexValue = 1\n", "utf-8")
    writeFileSync(join(existRoot, "package.json"), '{"name":"fixture","main":"dist/index.js"}', "utf-8")
    writeFileSync(join(existRoot, "README.md"), "fixture readme", "utf-8")
    writeFileSync(join(existRoot, ".env"), "R5SECRET=1", "utf-8")
    saveContextMap(existRoot, {
      id: archiveId,
      taskId: "t",
      projectConstitution: { architectureNotes: [], codingRules: [], forbiddenActions: [], buildCommands: [], testCommands: [], knownPitfalls: [], importantFiles: [] },
      repoStructure: { packageManager: "unknown", workspaces: [], sourceRoots: [], testRoots: [], configFiles: [], entrypoints: [], moduleHints: [] },
      locateResult: { primaryFiles: [], secondaryFiles: [], relevantSymbols: [], definitions: [], references: [], suspectedTests: [], confidence: 0.2, unresolvedQuestions: [] },
      sourceUnderstanding: { filesRead: [], dataFlowNotes: [], callFlow: [], invariants: [], assumptions: [], risks: [], likelyEditTargets: [] },
      verificationHints: { commands: [], suspectedTests: [] },
      confidence: 0.2,
      blockers: [],
    })
  })

  afterAll(() => {
    rmSync(existRoot, { recursive: true, force: true })
    rmSync(emptyRoot, { recursive: true, force: true })
  })

  /** 六个文件读取/元数据入口（无 authority 时必须确定性早退）。 */
  const readEntries: Array<{ name: string; call: (root: string) => unknown }> = [
    { name: "loadProjectConstitution", call: root => loadProjectConstitution(root, {}) },
    { name: "scanRepoStructure", call: root => scanRepoStructure(root, {}) },
    { name: "hybridLocate", call: root => hybridLocate(root, { userRequest: "indexValue export", keywords: ["indexvalue"] }, {}) },
    { name: "buildSourceUnderstanding", call: root => buildSourceUnderstanding(root, ["src/index.ts", "missing.ts", "package.json"], {}) },
    { name: "buildContextMap", call: root => buildContextMap(root, { taskId: "t", userRequest: "indexValue export" }, {}) },
    { name: "loadContextMap", call: root => loadContextMap(root, archiveId, {}) },
  ]

  test("无 authority：存在 fixture 与空 fixture 的每个入口结果逐字一致（无路径存在性 oracle）", () => {
    for (const entry of readEntries) {
      const fromExists = JSON.stringify(entry.call(existRoot))
      const fromEmpty = JSON.stringify(entry.call(emptyRoot))
      expect(fromExists, entry.name).toBe(fromEmpty)
    }
  })

  test("无 authority：probeCount=0 —— existsSync/statSync/readdirSync/readFileSync/realpathSync 零调用", async () => {
    const fs = await import("node:fs")
    const probes = [fs.existsSync, fs.statSync, fs.readdirSync, fs.readFileSync, fs.realpathSync]
    const spies = probes.map(fn => spyOn(fs, fn.name as never) as never)
    try {
      for (const entry of readEntries) {
        entry.call(existRoot)
      }
      for (const s of spies as Array<{ mock: { calls: unknown[] } }>) {
        expect(s.mock.calls.length).toBe(0)
      }
    } finally {
      for (const s of spies as Array<{ mockRestore: () => void }>) {
        s.mockRestore()
      }
    }
  })

  test("有 authority：行为保持正常（元数据可见、文件可读、归档可加载）", () => {
    const ws = wsFor(existRoot)
    const constitution = loadProjectConstitution(existRoot, { workspace: ws })
    expect(constitution.importantFiles).toContain("package.json")
    const structure = scanRepoStructure(existRoot, { workspace: ws })
    expect(structure.sourceRoots).toContain("src")
    expect(structure.packageManager).not.toBe("unknown")
    const located = hybridLocate(existRoot, { userRequest: "indexValue export", keywords: ["indexvalue"] }, { workspace: ws })
    expect(located.primaryFiles).toContain("src/index.ts")
    const understanding = buildSourceUnderstanding(existRoot, ["src/index.ts", "missing.ts"], { workspace: ws })
    expect(understanding.filesRead).toContain("src/index.ts")
    expect(understanding.filesRead).not.toContain("missing.ts")
    const map = buildContextMap(existRoot, { taskId: "t", userRequest: "indexValue export" }, { workspace: ws })
    expect(map.repoStructure.sourceRoots).toContain("src")
    expect(map.locateResult.primaryFiles).toContain("src/index.ts")
    expect(map.sourceUnderstanding.filesRead.length).toBeGreaterThan(0)
    const archive = loadContextMap(existRoot, archiveId, { workspace: ws })
    expect(archive?.id).toBe(archiveId)
    const missing = loadContextMap(existRoot, "ctx-000000000002", { workspace: ws })
    expect(missing).toBeNull()
  })
})
