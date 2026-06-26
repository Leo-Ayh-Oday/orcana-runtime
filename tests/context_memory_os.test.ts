import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildContextMemoryPack,
  ensureContextMemoryLayout,
  evaluateMemoryRetrieval,
  isDefaultInjectableCapsule,
  loadMemoryIndex,
  proposeMemoryUpdate,
  resolveMemoryIndexFiles,
  type MemoryCapsule,
} from "../src/memory/context-memory-os"

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "orcana-memory-os-"))
}

type CapsuleOverrides = Partial<Omit<MemoryCapsule, "scope" | "retrieval" | "validity">> & {
  scope?: Partial<MemoryCapsule["scope"]>
  retrieval?: Partial<MemoryCapsule["retrieval"]>
  validity?: Partial<MemoryCapsule["validity"]>
}

function capsule(overrides: CapsuleOverrides = {}): MemoryCapsule {
  const base: MemoryCapsule = {
    id: "cap-runtime",
    title: "Runtime evidence rule",
    kind: "project_rule",
    scope: {
      repo: "deepseek-orcana",
      module: "agent_runtime",
      files: ["src/agent/loop.ts"],
      appliesTo: ["agent_runtime"],
    },
    content: "Completion requires verification evidence before final done.",
    retrieval: {
      keywords: ["agent_runtime", "evidence", "completion"],
      symbols: ["evaluateCompletionGate"],
      commands: ["bun run typecheck"],
      relatedFiles: ["src/agent/completion-gate.ts"],
    },
    validity: {
      status: "active",
      createdAt: "2026-06-25T00:00:00.000Z",
      updatedAt: "2026-06-25T00:00:00.000Z",
      confidence: 0.92,
    },
    evidence: {
      source: "test",
      evidenceIds: ["tests/completion_gate.test.ts"],
    },
  }

  return {
    ...base,
    ...overrides,
    scope: { ...base.scope, ...(overrides.scope ?? {}) },
    retrieval: { ...base.retrieval, ...(overrides.retrieval ?? {}) },
    validity: { ...base.validity, ...(overrides.validity ?? {}) },
  }
}

describe("Context Memory OS", () => {
  test("creates the .orcana memory/state/index layout without overwriting files", () => {
    const root = tempRoot()
    try {
      const layout = ensureContextMemoryLayout(root)
      writeFileSync(layout.files.project, "custom project memory", "utf-8")

      const second = ensureContextMemoryLayout(root)

      expect(existsSync(second.files.memoryIndex)).toBe(true)
      expect(existsSync(join(root, ".orcana", "memory", "modules"))).toBe(true)
      expect(existsSync(join(root, ".orcana", "state"))).toBe(true)
      expect(existsSync(join(root, ".orcana", "index"))).toBe(true)
      expect(readFileSync(second.files.project, "utf-8")).toBe("custom project memory")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("loads MEMORY.md as an index, not as full memory content", () => {
    const root = tempRoot()
    try {
      const layout = ensureContextMemoryLayout(root)
      writeFileSync(layout.files.memoryIndex, [
        "# Orcana Memory Index",
        "",
        "## Always Load",
        "- project.md",
        "- commands.md",
        "",
        "## Topic Files",
        "- modules/tui.md",
        "- modules/context-epoch.md",
        "",
        "## Recent Decisions",
        "- D-1: keep TaskPacket across epoch rollover",
      ].join("\n"), "utf-8")
      writeFileSync(join(layout.memoryDir, "project.md"), "large project details should not be read here", "utf-8")

      const index = loadMemoryIndex(root)
      const files = resolveMemoryIndexFiles(index, root)

      expect(index.alwaysLoad).toEqual(["project.md", "commands.md"])
      expect(index.topicFiles).toEqual(["modules/tui.md", "modules/context-epoch.md"])
      expect(index.recentDecisions).toEqual(["D-1: keep TaskPacket across epoch rollover"])
      expect(index.raw).not.toContain("large project details")
      expect(files.some(file => file.endsWith(join(".orcana", "memory", "project.md")))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("memory index file resolution stays inside .orcana memory", () => {
    const root = tempRoot()
    try {
      const layout = ensureContextMemoryLayout(root)
      writeFileSync(layout.files.memoryIndex, [
        "# Orcana Memory Index",
        "",
        "## Always Load",
        "- project.md",
        "- ../secrets.env",
        "",
        "## Topic Files",
        "- modules/tui.md",
        "- ../../package.json",
      ].join("\n"), "utf-8")

      const files = resolveMemoryIndexFiles(loadMemoryIndex(root), root)

      expect(files).toHaveLength(2)
      expect(files.every(file => file.includes(join(".orcana", "memory")))).toBe(true)
      expect(files.some(file => file.endsWith("secrets.env"))).toBe(false)
      expect(files.some(file => file.endsWith("package.json"))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("injects only active high-confidence capsules by default", () => {
    const active = capsule()
    const low = capsule({ id: "low", validity: { status: "active", createdAt: "x", updatedAt: "x", confidence: 0.4 } })
    const stale = capsule({ id: "stale", validity: { status: "stale", createdAt: "x", updatedAt: "x", confidence: 0.95 } })
    const superseded = capsule({
      id: "superseded",
      validity: { status: "superseded", createdAt: "x", updatedAt: "x", confidence: 0.95, supersededBy: "newer" },
    })

    expect(isDefaultInjectableCapsule(active)).toBe(true)
    expect(isDefaultInjectableCapsule(low)).toBe(false)
    expect(isDefaultInjectableCapsule(stale)).toBe(false)
    expect(isDefaultInjectableCapsule(superseded)).toBe(false)
  })

  test("retrieval gate separates must-load, maybe-load, and do-not-load memory", () => {
    const result = evaluateMemoryRetrieval({
      userRequest: "fix agent runtime completion evidence handling",
      taskKind: "agent_runtime",
      currentFiles: ["src/agent/loop.ts"],
      activeSymbols: ["evaluateCompletionGate"],
      risk: "high",
    }, [
      capsule(),
      capsule({
        id: "stale-high",
        title: "Older evidence note",
        validity: { status: "stale", createdAt: "x", updatedAt: "x", confidence: 0.9 },
      }),
      capsule({
        id: "archived",
        title: "Archived note",
        validity: { status: "archived", createdAt: "x", updatedAt: "x", confidence: 1 },
      }),
      capsule({
        id: "unrelated",
        title: "TUI color note",
        kind: "debug_note",
        scope: { module: "tui", files: [], appliesTo: ["tui"] },
        content: "Dashboard palette changed.",
        retrieval: { keywords: ["tui", "color"], symbols: [], commands: [], relatedFiles: [] },
      }),
    ])

    expect(result.mustLoad.map(c => c.id)).toContain("cap-runtime")
    expect(result.maybeLoad.map(c => c.id)).toContain("stale-high")
    expect(result.doNotLoad).toContainEqual({ capsuleId: "archived", reason: "archived memory is not injected by default" })
    expect(result.mustLoad.map(c => c.id)).not.toContain("unrelated")
  })

  test("context packer preserves four-layer order and marks stable prefix", () => {
    const pack = buildContextMemoryPack({
      stablePrefix: {
        systemRules: "runtime owns completion",
        projectConstitution: "single agent first",
        memoryIndex: {
          path: ".orcana/memory/MEMORY.md",
          alwaysLoad: ["project.md"],
          topicFiles: ["modules/agent-loop.md"],
          recentDecisions: ["D-1"],
          raw: "full raw index",
        },
      },
      planState: "MasterPlan node 2 active",
      taskEpoch: "TaskPacket scope: src/memory/context-memory-os.ts",
      volatileTail: "last tool output",
    })

    expect(pack.sections.map(s => s.layer)).toEqual([
      "stable_prefix",
      "plan_state",
      "task_epoch",
      "volatile_tail",
    ])
    expect(pack.sections[0]?.stable).toBe(true)
    expect(pack.messages[0]?.content).toContain("## Stable Prefix")
    expect(pack.messages[0]?.content).toContain("alwaysLoad: project.md")
    expect(pack.messages[1]?.content).toContain("MasterPlan node 2 active")
  })

  test("context packer truncates oversized sections with a source-load reminder", () => {
    const pack = buildContextMemoryPack({
      stablePrefix: { memoryIndex: "index" },
      volatileTail: "x".repeat(80),
      maxSectionChars: 20,
    })

    const volatile = pack.sections.find(section => section.layer === "volatile_tail")
    expect(volatile?.truncated).toBe(true)
    expect(pack.messages.at(-1)?.content).toContain("load source memory file only if needed")
  })

  test("memory maintenance does not add unevidenced task summaries", () => {
    const proposal = proposeMemoryUpdate({
      trigger: "task_completed",
      taskId: "task-no-evidence",
      summary: "Completion requires verification evidence before final done.",
      existingCapsules: [],
    })

    expect(proposal.add).toHaveLength(0)
    expect(proposal.update).toHaveLength(0)
  })
})
