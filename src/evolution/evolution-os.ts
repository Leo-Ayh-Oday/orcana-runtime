/** Recursive Evolution OS — controlled self-improvement primitives.
 *
 * This file implements the proposal side of self-evolution: detect capability
 * gaps, acquire reusable knowledge in a fixed order, and produce upgrade
 * proposals. It does not apply runtime patches.
 */

import { existsSync, readFileSync } from "node:fs"
import { resolve, sep } from "node:path"
import {
  evaluateMemoryRetrieval,
  type MemoryCapsule,
  type MemoryRetrievalQuery,
} from "../memory/context-memory-os"

export type { MemoryCapsule } from "../memory/context-memory-os"

export type CapabilityGapKind =
  | "knowledge_gap"
  | "tool_gap"
  | "memory_gap"
  | "context_gap"
  | "planning_gap"
  | "editing_gap"
  | "verification_gap"
  | "runtime_gap"
  | "model_limit"

export interface CapabilityGapReport {
  id: string
  taskId: string
  kind: CapabilityGapKind
  symptoms: string[]
  failedAttempts: string[]
  suspectedRootCause: string
  shouldSelfUpgrade: boolean
  recommendedNextStep:
    | "retrieve_memory"
    | "web_search"
    | "write_skill"
    | "patch_runtime"
    | "add_replay_case"
    | "ask_user"
    | "stop"
}

export interface GapDetectionInput {
  taskId: string
  symptoms: string[]
  failedAttempts: string[]
  testFailures?: string[]
  contextLost?: boolean
  userCorrection?: string
}

export function detectCapabilityGap(input: GapDetectionInput): CapabilityGapReport {
  const text = [
    ...input.symptoms,
    ...input.failedAttempts,
    ...(input.testFailures ?? []),
    input.userCorrection ?? "",
  ].join(" ").toLowerCase()

  const kind = classifyGapKind(text, input)
  const repeated = input.failedAttempts.length >= 2 || (input.testFailures?.length ?? 0) >= 2 || Boolean(input.userCorrection)
  const shouldSelfUpgrade = repeated && kind !== "model_limit"

  return {
    id: `gap-${hashEvolutionText(`${input.taskId}:${kind}:${text}`).slice(0, 12)}`,
    taskId: input.taskId,
    kind,
    symptoms: input.symptoms,
    failedAttempts: input.failedAttempts,
    suspectedRootCause: summarizeRootCause(kind, input),
    shouldSelfUpgrade,
    recommendedNextStep: recommendNextStep(kind, shouldSelfUpgrade),
  }
}

function classifyGapKind(text: string, input: GapDetectionInput): CapabilityGapKind {
  if (input.contextLost || /forgot|lost context|epoch|taskpacket|上下文|忘/.test(text)) return "context_gap"
  if (/memory|remember|stale|superseded|记忆/.test(text)) return "memory_gap"
  if (/unknown api|docs|knowledge|not know|不了解|知识/.test(text)) return "knowledge_gap"
  if (/tool not found|missing tool|permission|mcp|工具/.test(text)) return "tool_gap"
  if (/plan|dependency|wrong file|scope|拆错|计划/.test(text)) return "planning_gap"
  if (/edit|patch|merge conflict|base hash|写错|修改/.test(text)) return "editing_gap"
  if (/test|typecheck|verify|evidence|replay|验证/.test(text)) return "verification_gap"
  if (/runtime|loop|sandbox|provider|gate|运行时/.test(text)) return "runtime_gap"
  if (/model limit|cannot infer|too ambiguous|模型/.test(text)) return "model_limit"
  return "knowledge_gap"
}

function summarizeRootCause(kind: CapabilityGapKind, input: GapDetectionInput): string {
  const first = input.symptoms[0] ?? input.failedAttempts[0] ?? "unknown failure"
  return `${kind}: ${first}`.slice(0, 240)
}

function recommendNextStep(kind: CapabilityGapKind, shouldSelfUpgrade: boolean): CapabilityGapReport["recommendedNextStep"] {
  if (!shouldSelfUpgrade) return kind === "model_limit" ? "ask_user" : "retrieve_memory"
  switch (kind) {
    case "knowledge_gap": return "web_search"
    case "memory_gap": return "retrieve_memory"
    case "context_gap": return "add_replay_case"
    case "planning_gap": return "add_replay_case"
    case "verification_gap": return "add_replay_case"
    case "tool_gap": return "write_skill"
    case "editing_gap": return "patch_runtime"
    case "runtime_gap": return "patch_runtime"
    case "model_limit": return "ask_user"
  }
}

// ── Knowledge acquisition ──

export type KnowledgeSource = "memory" | "repo" | "web" | "paper" | "official_docs"

export interface KnowledgeCapsule {
  id: string
  title: string
  source: KnowledgeSource
  url?: string
  summary: string
  appliesTo: string[]
  confidence: number
  freshness: "stable" | "time_sensitive"
  risks: string[]
  citations: string[]
}

export interface KnowledgeAcquisitionInput {
  query: MemoryRetrievalQuery
  memoryCapsules?: MemoryCapsule[]
  repoRoot?: string
  repoFiles?: string[]
  webResults?: Array<{ title: string; url: string; snippet: string; source?: KnowledgeSource }>
}

export interface KnowledgeAcquisitionResult {
  capsules: KnowledgeCapsule[]
  searched: KnowledgeSource[]
  blocked: string[]
}

export function acquireKnowledge(input: KnowledgeAcquisitionInput): KnowledgeAcquisitionResult {
  const capsules: KnowledgeCapsule[] = []
  const searched: KnowledgeSource[] = []
  const blocked: string[] = []

  if (input.memoryCapsules?.length) {
    searched.push("memory")
    const retrieved = evaluateMemoryRetrieval(input.query, input.memoryCapsules)
    for (const capsule of [...retrieved.mustLoad, ...retrieved.maybeLoad].slice(0, 6)) {
      capsules.push(knowledgeFromMemoryCapsule(capsule))
    }
  }

  if (input.repoRoot && input.repoFiles?.length) {
    searched.push("repo")
    const repoBase = resolve(input.repoRoot)
    for (const file of input.repoFiles.slice(0, 8)) {
      const abs = resolve(repoBase, file)
      if (!(abs === repoBase || abs.startsWith(repoBase + sep)) || !existsSync(abs)) continue
      const text = readFileSync(abs, "utf-8").slice(0, 2000)
      capsules.push(createKnowledgeCapsule({
        title: `Repo note: ${file}`,
        source: "repo",
        summary: summarizeRepoText(file, text),
        appliesTo: [input.query.taskKind, file],
        confidence: 0.72,
        freshness: "stable",
        citations: [file],
      }))
    }
  }

  if (input.webResults?.length) {
    searched.push("web")
    for (const result of input.webResults.slice(0, 5)) {
      capsules.push(createKnowledgeCapsule({
        title: result.title,
        source: result.source ?? "web",
        url: result.url,
        summary: result.snippet,
        appliesTo: [input.query.taskKind],
        confidence: result.source === "official_docs" || result.source === "paper" ? 0.82 : 0.68,
        freshness: result.source === "paper" ? "stable" : "time_sensitive",
        risks: ["External knowledge must be distilled before prompt injection."],
        citations: [result.url],
      }))
    }
  } else if (!capsules.length) {
    blocked.push("No memory, repo, or web knowledge sources supplied.")
  }

  return { capsules, searched, blocked }
}

function knowledgeFromMemoryCapsule(capsule: MemoryCapsule): KnowledgeCapsule {
  return createKnowledgeCapsule({
    title: capsule.title,
    source: "memory",
    summary: capsule.content,
    appliesTo: [...(capsule.scope.appliesTo ?? []), ...(capsule.scope.files ?? [])],
    confidence: capsule.validity.confidence,
    freshness: capsule.validity.status === "stale" ? "time_sensitive" : "stable",
    risks: capsule.validity.status === "stale" ? ["Memory is stale; verify before applying."] : [],
    citations: capsule.evidence?.evidenceIds ?? [capsule.id],
  })
}

export function createKnowledgeCapsule(input: Omit<KnowledgeCapsule, "id" | "risks"> & { risks?: string[] }): KnowledgeCapsule {
  return {
    id: `know-${hashEvolutionText(`${input.source}:${input.title}:${input.summary}`).slice(0, 12)}`,
    title: input.title.slice(0, 120),
    source: input.source,
    url: input.url,
    summary: input.summary.replace(/\s+/g, " ").trim().slice(0, 1200),
    appliesTo: [...new Set(input.appliesTo)].slice(0, 12),
    confidence: clamp01(input.confidence),
    freshness: input.freshness,
    risks: (input.risks ?? []).slice(0, 8),
    citations: [...new Set(input.citations)].slice(0, 12),
  }
}

function summarizeRepoText(file: string, text: string): string {
  const exports = text.match(/^export\s.+$/gm)?.slice(0, 5) ?? []
  const headings = text.match(/^#{1,3}\s.+$/gm)?.slice(0, 5) ?? []
  const snippets = [...exports, ...headings]
  return snippets.length
    ? `${file}: ${snippets.join(" | ")}`
    : `${file}: ${text.replace(/\s+/g, " ").trim().slice(0, 300)}`
}

// ── Upgrade proposal ──

export interface UpgradeProposal {
  id: string
  title: string
  gapReportId: string
  hypothesis: string
  target: {
    files: string[]
    modules:
      | "context"
      | "planning"
      | "memory"
      | "verification"
      | "editing"
      | "provider"
      | "tools"
      | "runtime"
  }
  proposedChange: string
  expectedBenefit: {
    metric: string
    targetDelta: string
  }
  validationPlan: {
    replayCases: string[]
    tests: string[]
    manualChecks: string[]
  }
  risk: {
    level: "low" | "medium" | "high"
    rollbackPlan: string
    requiresHumanApproval: boolean
  }
}

export function createUpgradeProposal(input: {
  gap: CapabilityGapReport
  knowledge?: KnowledgeCapsule[]
  targetFiles: string[]
  proposedChange: string
  replayCases?: string[]
  tests?: string[]
}): UpgradeProposal {
  const module = moduleForGap(input.gap.kind)
  const highRisk = input.targetFiles.some(file => /permission|sandbox|provider|context-epoch|tool-execution|evolution-policy/i.test(file))
  const title = `${input.gap.kind}: ${input.gap.suspectedRootCause}`.slice(0, 120)
  return {
    id: `proposal-${hashEvolutionText(`${input.gap.id}:${input.proposedChange}`).slice(0, 12)}`,
    title,
    gapReportId: input.gap.id,
    hypothesis: input.knowledge?.length
      ? `Applying ${input.knowledge.length} knowledge capsule(s) will reduce this ${input.gap.kind}.`
      : `A targeted runtime change can reduce this ${input.gap.kind}.`,
    target: {
      files: [...new Set(input.targetFiles)],
      modules: module,
    },
    proposedChange: input.proposedChange,
    expectedBenefit: {
      metric: input.gap.kind === "verification_gap" ? "replay pass rate" : "failure recurrence",
      targetDelta: input.gap.kind === "verification_gap" ? "+1 passing replay case" : "-1 repeated failure cluster",
    },
    validationPlan: {
      replayCases: input.replayCases ?? [],
      tests: input.tests ?? [],
      manualChecks: highRisk ? ["human approval required before merge"] : [],
    },
    risk: {
      level: highRisk ? "high" : input.targetFiles.length > 3 ? "medium" : "low",
      rollbackPlan: "revert isolated branch/worktree changes and keep proposal rejected",
      requiresHumanApproval: highRisk,
    },
  }
}

function moduleForGap(kind: CapabilityGapKind): UpgradeProposal["target"]["modules"] {
  switch (kind) {
    case "context_gap": return "context"
    case "memory_gap":
    case "knowledge_gap": return "memory"
    case "planning_gap": return "planning"
    case "editing_gap": return "editing"
    case "verification_gap": return "verification"
    case "tool_gap": return "tools"
    case "runtime_gap":
    case "model_limit": return "runtime"
  }
}

export function validateUpgradeProposal(proposal: UpgradeProposal): string[] {
  const issues: string[] = []
  if (!proposal.id) issues.push("missing proposal id")
  if (!proposal.gapReportId) issues.push("missing gap report id")
  if (!proposal.target.files.length) issues.push("missing target files")
  if (!proposal.proposedChange.trim()) issues.push("missing proposed change")
  if (!proposal.validationPlan.replayCases.length && !proposal.validationPlan.tests.length && !proposal.validationPlan.manualChecks.length) {
    issues.push("missing validation plan")
  }
  if (proposal.risk.level === "high" && !proposal.risk.requiresHumanApproval) {
    issues.push("high-risk proposal must require human approval")
  }
  return issues
}

// ── Evolution policy ──

export interface EvolutionPolicyDecision {
  allowed: boolean
  requiresHumanApproval: boolean
  reasons: string[]
}

const HIGH_RISK_FILE_RE = /(^|\/)(permission|sandbox|provider|context-epoch|evolution-policy|tool-execution)(\/|\.|-)|(^|\/)src\/sandbox\//i

export function evaluateEvolutionPolicy(
  proposal: UpgradeProposal,
  opts: { approvedProposalIds?: string[] } = {},
): EvolutionPolicyDecision {
  const reasons: string[] = []
  const highRiskFiles = proposal.target.files.filter(file => HIGH_RISK_FILE_RE.test(file))
  const requiresHumanApproval = proposal.risk.requiresHumanApproval || highRiskFiles.length > 0

  if (validateUpgradeProposal(proposal).length) reasons.push("proposal validation failed")
  if (!proposal.validationPlan.replayCases.length && !proposal.validationPlan.tests.length) {
    reasons.push("no replay or test validation")
  }
  if (proposal.proposedChange.match(/delete tests|remove replay|disable gate|bypass permission/i)) {
    reasons.push("proposal appears to weaken verification or safety gates")
  }
  if (requiresHumanApproval && !(opts.approvedProposalIds ?? []).includes(proposal.id)) {
    const files = highRiskFiles.length ? ` for high-risk target files: ${highRiskFiles.join(", ")}` : ""
    reasons.push(`human approval required${files}`)
  }

  return {
    allowed: reasons.length === 0,
    requiresHumanApproval,
    reasons,
  }
}

// ── Self-patch sandbox plan ──

export interface SelfPatchSandboxPlan {
  proposalId: string
  branchName: string
  worktreePath: string
  commands: string[]
  rollbackPlan: string
}

export function createSelfPatchSandboxPlan(proposal: UpgradeProposal, root = process.cwd()): SelfPatchSandboxPlan {
  const safeId = proposal.id.replace(/[^a-z0-9_-]/gi, "-").toLowerCase()
  const branchName = `self-upgrade/${safeId}`
  const worktreePath = resolve(root, ".orcana", "evolution", "experiments", safeId)
  return {
    proposalId: proposal.id,
    branchName,
    worktreePath,
    commands: [
      `git worktree add ${JSON.stringify(worktreePath)} -b ${branchName}`,
      "apply PatchTransaction in isolated worktree",
      ...proposal.validationPlan.tests,
      ...proposal.validationPlan.replayCases.map(test => `run replay ${test}`),
    ],
    rollbackPlan: `git worktree remove ${JSON.stringify(worktreePath)} --force; git branch -D ${branchName}`,
  }
}

// ── Evolution evaluator ──

export interface EvolutionReport {
  proposalId: string
  before: {
    passRate: number
    avgCost: number
    avgRounds: number
    failureClusters: Record<string, number>
  }
  after: {
    passRate: number
    avgCost: number
    avgRounds: number
    failureClusters: Record<string, number>
  }
  delta: {
    passRate: number
    cost: number
    regressions: string[]
  }
  decision: "accept" | "reject" | "needs_more_data"
}

export function evaluateEvolutionReport(input: Omit<EvolutionReport, "delta" | "decision">): EvolutionReport {
  const passRateDelta = round3(input.after.passRate - input.before.passRate)
  const costDelta = round3(input.after.avgCost - input.before.avgCost)
  const regressions = Object.entries(input.after.failureClusters)
    .filter(([cluster, count]) => count > (input.before.failureClusters[cluster] ?? 0))
    .map(([cluster]) => cluster)
  let decision: EvolutionReport["decision"] = "needs_more_data"
  if (passRateDelta > 0 && regressions.length === 0 && costDelta <= Math.max(0.05, input.before.avgCost * 0.2)) {
    decision = "accept"
  } else if (passRateDelta < 0 || regressions.length > 0 || costDelta > Math.max(0.1, input.before.avgCost * 0.5)) {
    decision = "reject"
  }
  return {
    ...input,
    delta: {
      passRate: passRateDelta,
      cost: costDelta,
      regressions,
    },
    decision,
  }
}

// ── Failure replay case generation ──

export interface FailureReplayCase {
  caseId: string
  domain: "evolution"
  description: string
  targetFunction: "detectCapabilityGap"
  input: GapDetectionInput
  expected: {
    domain: "evolution"
    description: string
    targetFunction: "detectCapabilityGap"
    kind: CapabilityGapKind
    shouldSelfUpgrade: boolean
    recommendedNextStep: CapabilityGapReport["recommendedNextStep"]
    assertions: string[]
  }
  tags: string[]
}

export function createFailureReplayCase(gap: CapabilityGapReport, input: GapDetectionInput): FailureReplayCase {
  return {
    caseId: `evolution-${gap.id}`,
    domain: "evolution",
    description: `Regression case for ${gap.kind}: ${gap.suspectedRootCause}`,
    targetFunction: "detectCapabilityGap",
    input,
    expected: {
      domain: "evolution",
      description: `Detect ${gap.kind}`,
      targetFunction: "detectCapabilityGap",
      kind: gap.kind,
      shouldSelfUpgrade: gap.shouldSelfUpgrade,
      recommendedNextStep: gap.recommendedNextStep,
      assertions: [
        `kind equals ${gap.kind}`,
        `shouldSelfUpgrade equals ${gap.shouldSelfUpgrade}`,
      ],
    },
    tags: ["evolution", gap.kind, "failure-replay"],
  }
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function hashEvolutionText(text: string): string {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  const len = (text.length & 0xffff).toString(16).padStart(4, "0")
  return (hash >>> 0).toString(16).padStart(8, "0") + len
}
