import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"

export type MemoryCardType =
  | "bug_pattern"
  | "project_rule"
  | "user_preference"
  | "verification_rule"
  | "architecture_decision"

export type MemoryCardStatus = "active" | "stale" | "superseded" | "rejected" | "archived"

export interface MemoryCard {
  id: string
  type: MemoryCardType
  scope: string
  trigger: string
  lesson: string
  doNot: string[]
  evidence: string[]
  verifiedBy?: string
  confidence: number
  status: MemoryCardStatus
  createdAt: number
  lastUsedAt?: number
  supersededBy?: string | null
}

export interface MemoryCandidate {
  type: MemoryCardType
  scope: string
  trigger: string
  lesson: string
  doNot?: string[]
  evidence?: string[]
  verifiedBy?: string
  confidence?: number
  status?: MemoryCardStatus
}

export interface MemoryGateScores {
  reusable: number
  verified: number
  futureImpact: number
  projectSpecific: number
  notCode: number
  notStale: number
}

export interface MemoryGateResult {
  accepted: boolean
  score: number
  reasons: string[]
  card?: MemoryCard
}

const ACCEPT_THRESHOLD = 0.75
const MAX_FIELD_CHARS = 600
const MAX_SNIPPET_CHARS = 180
const SECRET_PATTERNS = [
  /api[_-]?key\s*[:=]/i,
  /secret\s*[:=]/i,
  /token\s*[:=]\s*["']?[a-z0-9_\-.]{16,}/i,
  /password\s*[:=]/i,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
]

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function compact(text: string, limit = MAX_FIELD_CHARS): string {
  return text.replace(/\s+/g, " ").trim().slice(0, limit)
}

function containsCodeFence(text: string): boolean {
  return /```/.test(text)
}

function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some(pattern => pattern.test(text))
}

function containsLongSnippet(text: string): boolean {
  if (text.length > MAX_SNIPPET_CHARS && /[{};=]|\bfunction\b|\bclass\b|\bconst\b|\blet\b|\bexport\b/.test(text)) return true
  return text.split("\n").some(line => line.length > MAX_SNIPPET_CHARS)
}

function looksLikeUnverifiedGuess(candidate: MemoryCandidate): boolean {
  const text = `${candidate.trigger} ${candidate.lesson}`.toLowerCase()
  return !candidate.verifiedBy && /\b(maybe|probably|guess|seems|might|可能|也许|猜测|大概)\b/i.test(text)
}

function hardFilter(candidate: MemoryCandidate): string[] {
  const reasons: string[] = []
  const text = [
    candidate.scope,
    candidate.trigger,
    candidate.lesson,
    ...(candidate.doNot ?? []),
    ...(candidate.evidence ?? []),
    candidate.verifiedBy ?? "",
  ].join("\n")

  if (!candidate.scope.trim()) reasons.push("missing scope")
  if (!candidate.trigger.trim()) reasons.push("missing trigger")
  if (!candidate.lesson.trim()) reasons.push("missing lesson")
  if (containsCodeFence(text)) reasons.push("contains code fence")
  if (containsSecret(text)) reasons.push("contains possible secret")
  if (containsLongSnippet(text)) reasons.push("contains long code-like snippet")
  if (looksLikeUnverifiedGuess(candidate)) reasons.push("unverified guess")
  return reasons
}

export function scoreMemoryCandidate(candidate: MemoryCandidate): { score: number; scores: MemoryGateScores; reasons: string[] } {
  const reasons = hardFilter(candidate)
  const text = `${candidate.scope} ${candidate.trigger} ${candidate.lesson} ${(candidate.evidence ?? []).join(" ")} ${candidate.verifiedBy ?? ""}`
  const notCode = reasons.some(reason => reason.includes("code") || reason.includes("secret")) ? 0 : 1
  const verified = candidate.verifiedBy || (candidate.evidence?.length ?? 0) >= 2 ? 1 : 0
  const reusable = /\b(when|whenever|before|after|prefer|avoid|must|do not|如果|当|必须|不要|优先)\b/i.test(text) ? 1 : 0.45
  const futureImpact = /\b(ripple|typecheck|test|caller|cache|memory|contract|verification|rollback|context|长期|调用方|验证|缓存|记忆)\b/i.test(text) ? 1 : 0.45
  const projectSpecific = /\b(src\/|tests\/|\.ts|\.tsx|orcana|ripple|agentLoop|loop\.ts|compactor)\b/i.test(text) ? 1 : 0.55
  const notStale = candidate.status && candidate.status !== "active" ? 0 : 1
  const scores: MemoryGateScores = {
    reusable,
    verified,
    futureImpact,
    projectSpecific,
    notCode,
    notStale,
  }
  const score =
    scores.reusable * 0.25 +
    scores.verified * 0.25 +
    scores.futureImpact * 0.2 +
    scores.projectSpecific * 0.15 +
    scores.notCode * 0.1 +
    scores.notStale * 0.05
  return { score: Math.round(clamp01(score) * 1000) / 1000, scores, reasons }
}

export function evaluateMemoryCandidate(candidate: MemoryCandidate): MemoryGateResult {
  const scored = scoreMemoryCandidate(candidate)
  if (scored.reasons.length) {
    return { accepted: false, score: scored.score, reasons: scored.reasons }
  }
  if (scored.score < ACCEPT_THRESHOLD) {
    return { accepted: false, score: scored.score, reasons: [`score below threshold ${ACCEPT_THRESHOLD}`] }
  }

  const id = createHash("sha256")
    .update(`${candidate.type}:${candidate.scope}:${candidate.trigger}:${candidate.lesson}`)
    .digest("hex")
    .slice(0, 16)
  const card: MemoryCard = {
    id,
    type: candidate.type,
    scope: compact(candidate.scope, 200),
    trigger: compact(candidate.trigger),
    lesson: compact(candidate.lesson),
    doNot: (candidate.doNot ?? []).map(item => compact(item, 240)).filter(Boolean).slice(0, 8),
    evidence: (candidate.evidence ?? []).map(item => compact(item, 240)).filter(Boolean).slice(0, 12),
    verifiedBy: candidate.verifiedBy ? compact(candidate.verifiedBy, 240) : undefined,
    confidence: Math.round(clamp01(candidate.confidence ?? scored.score) * 1000) / 1000,
    status: candidate.status ?? "active",
    createdAt: Date.now(),
    lastUsedAt: undefined,
    supersededBy: null,
  }
  return { accepted: true, score: scored.score, reasons: [], card }
}

export class MemoryCardStore {
  private file: string
  private cards: MemoryCard[] = []

  constructor(private projectRoot = process.cwd()) {
    const dir = join(projectRoot, ".orcana")
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, "memory-cards.jsonl")
    this.load()
  }

  private load() {
    this.cards = []
    if (!existsSync(this.file)) return
    try {
      for (const line of readFileSync(this.file, "utf-8").split("\n")) {
        if (!line.trim()) continue
        const card = JSON.parse(line) as MemoryCard
        if (card.id && card.lesson) this.cards.push(card)
      }
    } catch {
      this.cards = []
    }
  }

  store(candidate: MemoryCandidate): MemoryGateResult {
    const result = evaluateMemoryCandidate(candidate)
    if (!result.accepted || !result.card) return result
    appendFileSync(this.file, JSON.stringify(result.card) + "\n", "utf-8")
    this.cards.push(result.card)
    return result
  }

  list(): MemoryCard[] {
    return [...this.cards]
  }

  activeCards(minConfidence = 0.75): MemoryCard[] {
    return this.cards.filter(card => card.status === "active" && card.confidence >= minConfidence)
  }
}

export function formatMemoryCardsForPrompt(cards: MemoryCard[], maxCards = 5): string {
  const active = cards.filter(card => card.status === "active" && card.confidence >= ACCEPT_THRESHOLD).slice(0, maxCards)
  if (!active.length) return ""

  const lines = [
    "## Project Memory Cards",
    "These are verified lessons and constraints, not source code. Do not copy them verbatim into files.",
  ]
  for (const card of active) {
    lines.push(`- [${card.type}] ${card.scope}`)
    lines.push(`  trigger: ${card.trigger}`)
    lines.push(`  lesson: ${card.lesson}`)
    if (card.doNot.length) lines.push(`  doNot: ${card.doNot.join(" | ")}`)
    if (card.verifiedBy) lines.push(`  verifiedBy: ${card.verifiedBy}`)
  }
  return lines.join("\n")
}
