import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  acquireKnowledge,
  createFailureReplayCase,
  createSelfPatchSandboxPlan,
  createKnowledgeCapsule,
  createUpgradeProposal,
  detectCapabilityGap,
  evaluateEvolutionPolicy,
  evaluateEvolutionReport,
  validateUpgradeProposal,
  type MemoryCapsule,
} from "../src/evolution/evolution-os"

function capsule(): MemoryCapsule {
  return {
    id: "mem-context",
    title: "Context epoch task state",
    kind: "project_rule",
    scope: { appliesTo: ["agent_runtime"], files: ["src/agent/context-epoch.ts"] },
    content: "Context Epoch must preserve TaskPacket and Evidence across rollover.",
    retrieval: { keywords: ["context", "epoch", "taskpacket", "evidence"] },
    validity: { status: "active", createdAt: "x", updatedAt: "x", confidence: 0.9 },
    evidence: { source: "test", evidenceIds: ["tests/context_epoch.test.ts"] },
  }
}

describe("Recursive Evolution OS foundation", () => {
  test("detects repeated context loss as a self-upgrade gap", () => {
    const gap = detectCapabilityGap({
      taskId: "task-context",
      symptoms: ["Context Epoch after rollover forgot active TaskPacket"],
      failedAttempts: ["retried same node", "lost evidence ledger again"],
      contextLost: true,
    })

    expect(gap.kind).toBe("context_gap")
    expect(gap.shouldSelfUpgrade).toBe(true)
    expect(gap.recommendedNextStep).toBe("add_replay_case")
    expect(gap.id).toMatch(/^gap-[a-f0-9]{12}$/)
  })

  test("single knowledge failure retrieves memory before self-upgrade", () => {
    const gap = detectCapabilityGap({
      taskId: "task-docs",
      symptoms: ["unknown API behavior"],
      failedAttempts: ["first failed attempt"],
    })

    expect(gap.kind).toBe("knowledge_gap")
    expect(gap.shouldSelfUpgrade).toBe(false)
    expect(gap.recommendedNextStep).toBe("retrieve_memory")
  })

  test("acquires knowledge in memory, repo, then web order", () => {
    const root = mkdtempSync(join(tmpdir(), "evolution-knowledge-"))
    try {
      mkdirSync(join(root, "docs"), { recursive: true })
      writeFileSync(join(root, "docs", "context.md"), "# Context Epoch\nexported docs preserve TaskPacket\n", "utf-8")

      const result = acquireKnowledge({
        query: {
          userRequest: "fix context epoch TaskPacket evidence rollover",
          taskKind: "agent_runtime",
          currentFiles: ["src/agent/context-epoch.ts"],
          risk: "high",
        },
        memoryCapsules: [capsule()],
        repoRoot: root,
        repoFiles: ["docs/context.md"],
        webResults: [
          {
            title: "Official context cache docs",
            url: "https://api-docs.deepseek.com/guides/kv_cache",
            snippet: "Stable prefixes improve cache hit rates.",
            source: "official_docs",
          },
        ],
      })

      expect(result.searched).toEqual(["memory", "repo", "web"])
      expect(result.capsules.map(c => c.source)).toEqual(["memory", "repo", "official_docs"])
      expect(result.capsules[0]?.citations).toContain("tests/context_epoch.test.ts")
      expect(result.capsules[2]?.freshness).toBe("time_sensitive")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("knowledge capsule generation clamps confidence and strips excess whitespace", () => {
    const knowledge = createKnowledgeCapsule({
      title: "  DeepSeek cache  ",
      source: "web",
      url: "https://example.com",
      summary: "Stable\n\nprefixes    help.",
      appliesTo: ["agent_runtime", "agent_runtime"],
      confidence: 2,
      freshness: "time_sensitive",
      citations: ["https://example.com", "https://example.com"],
    })

    expect(knowledge.confidence).toBe(1)
    expect(knowledge.summary).toBe("Stable prefixes help.")
    expect(knowledge.appliesTo).toEqual(["agent_runtime"])
    expect(knowledge.citations).toEqual(["https://example.com"])
  })

  test("repo knowledge acquisition ignores files outside repo root", () => {
    const root = mkdtempSync(join(tmpdir(), "evolution-escape-"))
    try {
      const result = acquireKnowledge({
        query: {
          userRequest: "load docs",
          taskKind: "agent_runtime",
          risk: "medium",
        },
        repoRoot: root,
        repoFiles: ["../outside.md"],
      })

      expect(result.searched).toEqual(["repo"])
      expect(result.capsules).toHaveLength(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("creates high-risk upgrade proposals that require human approval", () => {
    const gap = detectCapabilityGap({
      taskId: "task-runtime",
      symptoms: ["runtime gate let completion pass without evidence"],
      failedAttempts: ["test failed", "replay failed"],
      testFailures: ["false-done replay failed", "completion gate failed"],
    })
    const proposal = createUpgradeProposal({
      gap,
      targetFiles: ["src/agent/evolution-policy.ts", "src/agent/completion-gate.ts"],
      proposedChange: "Add a stricter completion evidence check and replay coverage.",
      replayCases: ["false-done/missing-verification"],
      tests: ["bun test tests/completion_gate.test.ts"],
    })

    expect(proposal.risk.level).toBe("high")
    expect(proposal.risk.requiresHumanApproval).toBe(true)
    expect(proposal.validationPlan.manualChecks).toContain("human approval required before merge")
    expect(validateUpgradeProposal(proposal)).toEqual([])
  })

  test("proposal validation rejects missing validation evidence", () => {
    const gap = detectCapabilityGap({
      taskId: "task-editing",
      symptoms: ["patch edited wrong file"],
      failedAttempts: ["wrong file once", "wrong file twice"],
    })
    const proposal = createUpgradeProposal({
      gap,
      targetFiles: ["src/agent/patch-transaction.ts"],
      proposedChange: "Tighten scope checks.",
      replayCases: [],
      tests: [],
    })
    proposal.validationPlan.manualChecks = []

    expect(validateUpgradeProposal(proposal)).toContain("missing validation plan")
  })

  test("evolution policy blocks high-risk proposals until approved", () => {
    const gap = detectCapabilityGap({
      taskId: "task-policy",
      symptoms: ["sandbox runtime failed"],
      failedAttempts: ["first failure", "second failure"],
    })
    const proposal = createUpgradeProposal({
      gap,
      targetFiles: ["src/sandbox/sandbox.ts"],
      proposedChange: "Tighten sandbox isolation checks.",
      replayCases: ["evolution/sandbox-failure"],
      tests: ["bun test tests/safety_policy.test.ts"],
    })

    const blocked = evaluateEvolutionPolicy(proposal)
    const approved = evaluateEvolutionPolicy(proposal, { approvedProposalIds: [proposal.id] })

    expect(blocked.allowed).toBe(false)
    expect(blocked.requiresHumanApproval).toBe(true)
    expect(blocked.reasons.some(reason => reason.includes("human approval required"))).toBe(true)
    expect(approved.allowed).toBe(true)
    expect(approved.reasons).toEqual([])
  })

  test("self-patch sandbox plan uses isolated branch and worktree commands", () => {
    const gap = detectCapabilityGap({
      taskId: "task-sandbox-plan",
      symptoms: ["verification replay failed"],
      failedAttempts: ["first failure", "second failure"],
      testFailures: ["replay failed", "typecheck failed"],
    })
    const proposal = createUpgradeProposal({
      gap,
      targetFiles: ["src/agent/completion-gate.ts"],
      proposedChange: "Add stricter replay-backed completion check.",
      replayCases: ["false-done/missing-verification"],
      tests: ["bun test tests/completion_gate.test.ts"],
    })
    const plan = createSelfPatchSandboxPlan(proposal, "E:/repo")

    expect(plan.branchName).toContain("self-upgrade/")
    expect(plan.commands[0]).toContain("git worktree add")
    expect(plan.commands).toContain("bun test tests/completion_gate.test.ts")
    expect(plan.commands).toContain("run replay false-done/missing-verification")
    expect(plan.rollbackPlan).toContain("git worktree remove")
  })

  test("evolution policy rejects proposals that weaken gates or replay", () => {
    const gap = detectCapabilityGap({
      taskId: "task-unsafe",
      symptoms: ["replay is failing"],
      failedAttempts: ["failed once", "failed twice"],
    })
    const proposal = createUpgradeProposal({
      gap,
      targetFiles: ["src/agent/completion-gate.ts"],
      proposedChange: "Disable gate and remove replay so completion passes.",
      replayCases: ["false-done/missing-verification"],
      tests: ["bun test tests/completion_gate.test.ts"],
    })

    const decision = evaluateEvolutionPolicy(proposal)

    expect(decision.allowed).toBe(false)
    expect(decision.reasons).toContain("proposal appears to weaken verification or safety gates")
  })

  test("evolution evaluator accepts only replay-backed improvement without regressions", () => {
    const accepted = evaluateEvolutionReport({
      proposalId: "proposal-good",
      before: { passRate: 0.7, avgCost: 1, avgRounds: 4, failureClusters: { context: 2 } },
      after: { passRate: 0.85, avgCost: 1.05, avgRounds: 3, failureClusters: { context: 1 } },
    })
    const rejected = evaluateEvolutionReport({
      proposalId: "proposal-bad",
      before: { passRate: 0.8, avgCost: 1, avgRounds: 4, failureClusters: { context: 1 } },
      after: { passRate: 0.82, avgCost: 1.8, avgRounds: 4, failureClusters: { context: 1, ripple: 1 } },
    })

    expect(accepted.decision).toBe("accept")
    expect(accepted.delta.passRate).toBe(0.15)
    expect(rejected.decision).toBe("reject")
    expect(rejected.delta.regressions).toContain("ripple")
  })

  test("failure replay case captures gap detector expected output", () => {
    const input = {
      taskId: "task-replay",
      symptoms: ["Planner picked the wrong file scope"],
      failedAttempts: ["bad plan once", "bad plan twice"],
    }
    const gap = detectCapabilityGap(input)
    const replay = createFailureReplayCase(gap, input)

    expect(replay.caseId).toBe(`evolution-${gap.id}`)
    expect(replay.domain).toBe("evolution")
    expect(replay.expected.kind).toBe(gap.kind)
    expect(replay.expected.shouldSelfUpgrade).toBe(true)
    expect(replay.tags).toContain("failure-replay")
  })
})
