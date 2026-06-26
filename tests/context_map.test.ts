import { describe, expect, test } from "bun:test"
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
  test("loads project constitution from docs, memory index, and package scripts", () => {
    const root = createRepo()
    try {
      const constitution = loadProjectConstitution(root)

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
      const structure = scanRepoStructure(root)

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
      })

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
      ])

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
      })
      const readiness = evaluateContextReadiness(map, "long")
      const stored = saveContextMap(root, map)
      const loaded = loadContextMap(root, map.id)

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
      })
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
      })
      const readiness = evaluateContextReadiness(map, "high_risk")

      expect(readiness.blockers).toContain("High-risk task confidence below 0.75.")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
