import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  evaluateMemoryCandidate,
  formatMemoryCardsForPrompt,
  MemoryCardStore,
  scoreMemoryCandidate,
} from "../src/memory/distillation-gate"

describe("Memory Distillation Gate", () => {
  test("rejects ordinary logs", () => {
    const result = evaluateMemoryCandidate({
      type: "bug_pattern",
      scope: "orcana:logs",
      trigger: "tool output",
      lesson: "Command printed normal progress lines.",
      evidence: ["shell output"],
    })

    expect(result.accepted).toBe(false)
    expect(result.reasons).toContain("score below threshold 0.75")
  })

  test("rejects unverified guesses", () => {
    const result = evaluateMemoryCandidate({
      type: "architecture_decision",
      scope: "orcana:cache",
      trigger: "maybe cache is low",
      lesson: "Maybe tool schemas are causing cache misses.",
      evidence: ["model guess"],
    })

    expect(result.accepted).toBe(false)
    expect(result.reasons).toContain("unverified guess")
  })

  test("rejects code fences and long code-like snippets", () => {
    const fenced = evaluateMemoryCandidate({
      type: "bug_pattern",
      scope: "orcana:ripple",
      trigger: "when tests fail",
      lesson: "```ts\nexport function bad() { return 1 }\n```",
      verifiedBy: "bun test",
      evidence: ["tests/ripple.test.ts"],
    })
    expect(fenced.accepted).toBe(false)
    expect(fenced.reasons).toContain("contains code fence")

    const longSnippet = evaluateMemoryCandidate({
      type: "bug_pattern",
      scope: "orcana:ripple",
      trigger: "when tests fail",
      lesson: `Use this implementation: ${"const value = call(); ".repeat(20)}`,
      verifiedBy: "bun test",
      evidence: ["tests/ripple.test.ts"],
    })
    expect(longSnippet.accepted).toBe(false)
    expect(longSnippet.reasons).toContain("contains long code-like snippet")
  })

  test("accepts a verified Ripple cascade lesson", () => {
    const result = evaluateMemoryCandidate({
      type: "bug_pattern",
      scope: "orcana:ripple",
      trigger: "When changing exported TS signatures with external callers",
      lesson: "Prefer multi_edit so target and caller changes land atomically before final verification.",
      doNot: ["Do not claim completion while Ripple obligations remain."],
      evidence: ["src/tools/file.ts", "src/ripple/obligations.ts", "tests/agent_loop.test.ts"],
      verifiedBy: "bun test tests/ripple.test.ts tests/agent_loop.test.ts",
      confidence: 0.88,
    })

    expect(result.accepted).toBe(true)
    expect(result.score).toBeGreaterThanOrEqual(0.75)
    expect(result.card?.lesson).toContain("Prefer multi_edit")
  })

  test("stores accepted cards outside source code", () => {
    const dir = mkdtempSync(join(tmpdir(), "deepseek-memory-cards-"))
    try {
      const store = new MemoryCardStore(dir)
      const result = store.store({
        type: "verification_rule",
        scope: "orcana:cache-anatomy",
        trigger: "When token_usage changes",
        lesson: "Run focused agent_loop and token_hud tests before claiming cache telemetry is stable.",
        evidence: ["tests/agent_loop.test.ts", "tests/token_hud.test.ts"],
        verifiedBy: "bun test tests/agent_loop.test.ts tests/token_hud.test.ts",
      })

      expect(result.accepted).toBe(true)
      const file = join(dir, ".orcana", "memory-cards.jsonl")
      expect(existsSync(file)).toBe(true)
      expect(readFileSync(file, "utf-8")).toContain("cache telemetry")
      expect(store.list().length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("formats memory cards as guidance, not source code", () => {
    const result = evaluateMemoryCandidate({
      type: "project_rule",
      scope: "orcana:runtime",
      trigger: "Before final answer in execute mode",
      lesson: "Check Ripple obligations and verification evidence before claiming completion.",
      doNot: ["Do not copy memory cards into source files."],
      evidence: ["src/agent/loop.ts", "tests/agent_loop.test.ts"],
      verifiedBy: "bun test tests/agent_loop.test.ts",
      confidence: 0.9,
    })

    const prompt = formatMemoryCardsForPrompt([result.card!])
    expect(prompt).toContain("not source code")
    expect(prompt).toContain("trigger:")
    expect(prompt).toContain("lesson:")
    expect(prompt).not.toContain("```")
  })

  test("excludes low-confidence and stale cards from default prompt injection", () => {
    const active = evaluateMemoryCandidate({
      type: "project_rule",
      scope: "orcana:runtime",
      trigger: "When verification passes",
      lesson: "Record verification evidence in the final report.",
      evidence: ["process/reports"],
      verifiedBy: "user confirmation",
      confidence: 0.9,
    }).card!
    const low = { ...active, id: "low", confidence: 0.5 }
    const stale = { ...active, id: "stale", status: "stale" as const }

    const prompt = formatMemoryCardsForPrompt([low, stale, active])
    expect(prompt).toContain(active.lesson)
    expect(prompt).not.toContain("id: low")
    expect(prompt).not.toContain("stale")
  })

  test("scores verified project-specific future-impact candidates above threshold", () => {
    const scored = scoreMemoryCandidate({
      type: "bug_pattern",
      scope: "orcana:compactor",
      trigger: "When M0 is created from warm records",
      lesson: "Avoid putting raw transcript gist into prompt; archive raw turns locally and keep M0 high-level.",
      evidence: ["src/memory/compactor.ts", "tests/context_compactor.test.ts"],
      verifiedBy: "bun test tests/context_compactor.test.ts",
    })

    expect(scored.score).toBeGreaterThanOrEqual(0.75)
  })
})
