/** Context Memory OS — indexed long-term project memory.
 *
 * This module is intentionally runtime-owned and mostly pure. It gives Orcana a
 * stable memory index, explicit capsule schema, retrieval gate, and four-layer
 * packer without injecting full history by default.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import type { ProviderMessage } from "../provider/types"

// ── Layout ──

export const ORCANA_MEMORY_DIR = ".orcana/memory"

export interface ContextMemoryLayout {
  root: string
  memoryDir: string
  stateDir: string
  indexDir: string
  files: {
    memoryIndex: string
    project: string
    architecture: string
    commands: string
    decisions: string
    failures: string
    patterns: string
  }
}

export function contextMemoryLayout(root = process.cwd()): ContextMemoryLayout {
  const memoryDir = join(root, ".orcana", "memory")
  return {
    root,
    memoryDir,
    stateDir: join(root, ".orcana", "state"),
    indexDir: join(root, ".orcana", "index"),
    files: {
      memoryIndex: join(memoryDir, "MEMORY.md"),
      project: join(memoryDir, "project.md"),
      architecture: join(memoryDir, "architecture.md"),
      commands: join(memoryDir, "commands.md"),
      decisions: join(memoryDir, "decisions.jsonl"),
      failures: join(memoryDir, "failures.jsonl"),
      patterns: join(memoryDir, "patterns.jsonl"),
    },
  }
}

export function ensureContextMemoryLayout(root = process.cwd()): ContextMemoryLayout {
  const layout = contextMemoryLayout(root)
  mkdirSync(layout.memoryDir, { recursive: true })
  mkdirSync(join(layout.memoryDir, "modules"), { recursive: true })
  mkdirSync(join(layout.memoryDir, "tasks"), { recursive: true })
  mkdirSync(layout.stateDir, { recursive: true })
  mkdirSync(layout.indexDir, { recursive: true })

  const seedFiles: Array<[string, string]> = [
    [layout.files.memoryIndex, DEFAULT_MEMORY_INDEX],
    [layout.files.project, "# Project Memory\n\n"],
    [layout.files.architecture, "# Architecture Memory\n\n"],
    [layout.files.commands, "# Command Memory\n\n"],
    [layout.files.decisions, ""],
    [layout.files.failures, ""],
    [layout.files.patterns, ""],
  ]
  for (const [path, content] of seedFiles) {
    if (!existsSync(path)) writeFileSync(path, content, "utf-8")
  }
  return layout
}

export const DEFAULT_MEMORY_INDEX = [
  "# Orcana Memory Index",
  "",
  "## Always Load",
  "- project.md",
  "- commands.md",
  "- architecture.md",
  "",
  "## Topic Files",
  "- modules/agent-loop.md",
  "- modules/context-epoch.md",
  "- modules/provider-deepseek.md",
  "- modules/tui.md",
  "- modules/verification.md",
  "",
  "## Recent Decisions",
].join("\n")

// ── Memory index ──

export interface MemoryIndex {
  path: string
  alwaysLoad: string[]
  topicFiles: string[]
  recentDecisions: string[]
  raw: string
}

export function loadMemoryIndex(root = process.cwd()): MemoryIndex {
  const layout = contextMemoryLayout(root)
  const raw = existsSync(layout.files.memoryIndex)
    ? readFileSync(layout.files.memoryIndex, "utf-8")
    : ""
  const sections = parseMarkdownListSections(raw)
  return {
    path: layout.files.memoryIndex,
    alwaysLoad: sections["Always Load"] ?? [],
    topicFiles: sections["Topic Files"] ?? [],
    recentDecisions: sections["Recent Decisions"] ?? [],
    raw,
  }
}

export function resolveMemoryIndexFiles(index: MemoryIndex, root = process.cwd()): string[] {
  const base = resolve(root, ORCANA_MEMORY_DIR)
  return [...index.alwaysLoad, ...index.topicFiles]
    .filter(Boolean)
    .map(file => {
      const target = resolve(base, file)
      return target === base || target.startsWith(base + sep) ? target : null
    })
    .filter((file): file is string => file !== null)
}

function parseMarkdownListSections(raw: string): Record<string, string[]> {
  const sections: Record<string, string[]> = {}
  let current: string | null = null
  for (const line of raw.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/)
    if (heading) {
      current = heading[1]!
      sections[current] = sections[current] ?? []
      continue
    }
    const item = line.match(/^-\s+(.+?)\s*$/)
    if (item && current) sections[current]!.push(item[1]!)
  }
  return sections
}

// ── Capsule schema ──

export type MemoryCapsuleKind =
  | "project_rule"
  | "architecture"
  | "decision"
  | "failure_pattern"
  | "debug_note"
  | "command"
  | "module_summary"
  | "task_summary"
  | "skill_recipe"

export type MemoryCapsuleStatus = "active" | "stale" | "superseded" | "archived"

export interface MemoryCapsule {
  id: string
  title: string
  kind: MemoryCapsuleKind
  scope: {
    repo?: string
    module?: string
    files?: string[]
    appliesTo?: string[]
  }
  content: string
  retrieval: {
    keywords: string[]
    symbols?: string[]
    commands?: string[]
    relatedFiles?: string[]
  }
  validity: {
    status: MemoryCapsuleStatus
    createdAt: string
    updatedAt: string
    lastVerifiedAt?: string
    confidence: number
    supersededBy?: string
  }
  evidence?: {
    source: "user" | "tool" | "test" | "review" | "manual"
    evidenceIds?: string[]
  }
}

export function validateMemoryCapsule(capsule: MemoryCapsule): string[] {
  const issues: string[] = []
  if (!capsule.id.trim()) issues.push("missing id")
  if (!capsule.title.trim()) issues.push("missing title")
  if (!capsule.content.trim()) issues.push("missing content")
  if (!capsule.retrieval.keywords.length) issues.push("missing retrieval keywords")
  if (!Number.isFinite(capsule.validity.confidence)) issues.push("invalid confidence")
  if (capsule.validity.confidence < 0 || capsule.validity.confidence > 1) issues.push("confidence out of range")
  if (capsule.validity.status === "superseded" && !capsule.validity.supersededBy) {
    issues.push("superseded capsule missing supersededBy")
  }
  return issues
}

export function isDefaultInjectableCapsule(capsule: MemoryCapsule, minConfidence = 0.65): boolean {
  return capsule.validity.status === "active" && capsule.validity.confidence >= minConfidence
}

// ── Retrieval gate ──

export type MemoryTaskKind =
  | "bug_fix"
  | "refactor"
  | "feature"
  | "tui"
  | "provider"
  | "agent_runtime"
  | "unknown"

export interface MemoryRetrievalQuery {
  userRequest: string
  taskKind: MemoryTaskKind
  currentFiles?: string[]
  activeSymbols?: string[]
  risk: "low" | "medium" | "high"
}

export interface MemoryRetrievalResult {
  mustLoad: MemoryCapsule[]
  maybeLoad: MemoryCapsule[]
  doNotLoad: Array<{ capsuleId: string; reason: string }>
}

export function evaluateMemoryRetrieval(
  query: MemoryRetrievalQuery,
  capsules: MemoryCapsule[],
): MemoryRetrievalResult {
  const mustLoad: MemoryCapsule[] = []
  const maybeLoad: MemoryCapsule[] = []
  const doNotLoad: Array<{ capsuleId: string; reason: string }> = []

  for (const capsule of capsules) {
    const validation = validateMemoryCapsule(capsule)
    if (validation.length) {
      doNotLoad.push({ capsuleId: capsule.id || "(missing)", reason: validation.join("; ") })
      continue
    }

    const status = capsule.validity.status
    if (status === "superseded" || status === "archived") {
      doNotLoad.push({ capsuleId: capsule.id, reason: `${status} memory is not injected by default` })
      continue
    }

    const score = scoreCapsuleForQuery(query, capsule)
    if (status === "stale") {
      if (score >= 0.75 && query.risk !== "low") maybeLoad.push(capsule)
      else doNotLoad.push({ capsuleId: capsule.id, reason: "stale memory below retrieval threshold" })
      continue
    }

    if (score >= 0.75 && capsule.validity.confidence >= 0.65) mustLoad.push(capsule)
    else if (score >= 0.45) maybeLoad.push(capsule)
    else doNotLoad.push({ capsuleId: capsule.id, reason: "not relevant to retrieval query" })
  }

  return {
    mustLoad: sortCapsules(mustLoad, query),
    maybeLoad: sortCapsules(maybeLoad, query),
    doNotLoad,
  }
}

export function scoreCapsuleForQuery(query: MemoryRetrievalQuery, capsule: MemoryCapsule): number {
  const haystack = [
    capsule.title,
    capsule.kind,
    capsule.scope.module ?? "",
    ...(capsule.scope.files ?? []),
    ...(capsule.scope.appliesTo ?? []),
    capsule.content,
    ...capsule.retrieval.keywords,
    ...(capsule.retrieval.symbols ?? []),
    ...(capsule.retrieval.commands ?? []),
    ...(capsule.retrieval.relatedFiles ?? []),
  ].join(" ").toLowerCase()
  const queryText = [
    query.userRequest,
    query.taskKind,
    ...(query.currentFiles ?? []),
    ...(query.activeSymbols ?? []),
  ].join(" ").toLowerCase()
  const queryTerms = tokenizeQuery(queryText)
  if (!queryTerms.length) return 0

  let hits = 0
  for (const term of queryTerms) {
    if (haystack.includes(term)) hits++
  }
  const keywordScore = hits / queryTerms.length
  const fileBoost = (query.currentFiles ?? []).some(file => (capsule.scope.files ?? []).includes(file) || (capsule.retrieval.relatedFiles ?? []).includes(file)) ? 0.25 : 0
  const kindBoost = capsule.scope.appliesTo?.includes(query.taskKind) || capsule.retrieval.keywords.includes(query.taskKind) ? 0.2 : 0
  const confidenceBoost = capsule.validity.confidence * 0.15
  const riskBoost = query.risk === "high" && capsule.kind === "project_rule" ? 0.1 : 0
  return clamp01(keywordScore + fileBoost + kindBoost + confidenceBoost + riskBoost)
}

function sortCapsules(capsules: MemoryCapsule[], query: MemoryRetrievalQuery): MemoryCapsule[] {
  return [...capsules].sort((a, b) => scoreCapsuleForQuery(query, b) - scoreCapsuleForQuery(query, a))
}

function tokenizeQuery(text: string): string[] {
  return [...new Set(text.split(/[^a-z0-9_./-]+/i).map(s => s.trim().toLowerCase()).filter(s => s.length >= 2))]
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

// ── Four-layer ContextPacker ──

export interface ContextPackInput {
  stablePrefix: {
    systemRules?: string
    toolSchema?: string
    projectConstitution?: string
    memoryIndex?: MemoryIndex | string
  }
  planState?: string
  taskEpoch?: string
  volatileTail?: string
  maxSectionChars?: number
}

export interface ContextPackSection {
  layer: "stable_prefix" | "plan_state" | "task_epoch" | "volatile_tail"
  title: string
  chars: number
  stable: boolean
  truncated: boolean
}

export interface ContextPackResult {
  messages: ProviderMessage[]
  sections: ContextPackSection[]
  totalChars: number
}

export function buildContextMemoryPack(input: ContextPackInput): ContextPackResult {
  const max = input.maxSectionChars ?? 12_000
  const stableParts = [
    sectionText("System Rules", input.stablePrefix.systemRules),
    sectionText("Tool Schema", input.stablePrefix.toolSchema),
    sectionText("Project Constitution", input.stablePrefix.projectConstitution),
    sectionText("Memory Index", formatMemoryIndex(input.stablePrefix.memoryIndex)),
  ].filter(Boolean)

  const candidates: Array<{ layer: ContextPackSection["layer"]; title: string; stable: boolean; content?: string }> = [
    { layer: "stable_prefix", title: "Stable Prefix", stable: true, content: stableParts.join("\n\n") },
    { layer: "plan_state", title: "Plan State", stable: false, content: input.planState },
    { layer: "task_epoch", title: "Task Epoch", stable: false, content: input.taskEpoch },
    { layer: "volatile_tail", title: "Volatile Tail", stable: false, content: input.volatileTail },
  ]

  const messages: ProviderMessage[] = []
  const sections: ContextPackSection[] = []
  for (const candidate of candidates) {
    const raw = candidate.content?.trim()
    if (!raw) continue
    const { content, truncated } = truncateSection(raw, max)
    const body = [`## ${candidate.title}`, content].join("\n")
    messages.push({ role: "user", content: body })
    sections.push({
      layer: candidate.layer,
      title: candidate.title,
      chars: body.length,
      stable: candidate.stable,
      truncated,
    })
  }

  return {
    messages,
    sections,
    totalChars: messages.reduce((sum, msg) => sum + (typeof msg.content === "string" ? msg.content.length : JSON.stringify(msg.content).length), 0),
  }
}

// ── Memory maintenance hook ──

export type MemoryMaintenanceTrigger =
  | "task_completed"
  | "failure_attribution"
  | "user_correction"
  | "context_epoch"

export interface MemoryUpdateProposal {
  add: MemoryCapsule[]
  update: Array<{ capsuleId: string; patch: string }>
  markStale: Array<{ capsuleId: string; reason: string }>
  archive: Array<{ capsuleId: string; reason: string }>
}

export interface MemoryMaintenanceInput {
  trigger: MemoryMaintenanceTrigger
  taskId: string
  summary: string
  candidate?: MemoryCapsule
  existingCapsules?: MemoryCapsule[]
  evidenceIds?: string[]
}

export function proposeMemoryUpdate(input: MemoryMaintenanceInput): MemoryUpdateProposal {
  const proposal: MemoryUpdateProposal = { add: [], update: [], markStale: [], archive: [] }
  const existing = input.existingCapsules ?? []
  const candidate = input.candidate ?? capsuleFromMaintenanceInput(input)
  const validation = validateMemoryCapsule(candidate)
  const hasEvidence = input.trigger === "user_correction" ||
    Boolean(input.evidenceIds?.length) ||
    Boolean(candidate.evidence?.evidenceIds?.length)

  if (!hasEvidence || validation.length || isShortTermState(input.summary) || containsSensitiveMemory(input.summary)) {
    return proposal
  }

  if (input.trigger === "user_correction") {
    for (const capsule of existing) {
      if (capsule.validity.status === "active" && capsuleSimilarity(capsule, candidate) >= 0.25) {
        proposal.markStale.push({ capsuleId: capsule.id, reason: "user correction may supersede this memory" })
      }
    }
  }

  const duplicate = existing.find(item => capsuleSimilarity(item, candidate) >= 0.72)
  if (duplicate) {
    if (candidate.validity.confidence > duplicate.validity.confidence) {
      proposal.update.push({
        capsuleId: duplicate.id,
        patch: `refresh from ${input.trigger}: ${candidate.title}`,
      })
    }
    return proposal
  }

  proposal.add.push(candidate)
  return proposal
}

function capsuleFromMaintenanceInput(input: MemoryMaintenanceInput): MemoryCapsule {
  const now = new Date().toISOString()
  const kind: MemoryCapsuleKind = input.trigger === "failure_attribution"
    ? "failure_pattern"
    : input.trigger === "user_correction"
      ? "project_rule"
      : "task_summary"
  return {
    id: `mem-${hashMemoryText(`${input.taskId}:${input.summary}`).slice(0, 12)}`,
    title: input.summary.slice(0, 80),
    kind,
    scope: { appliesTo: ["agent_runtime"] },
    content: input.summary.slice(0, 1200),
    retrieval: {
      keywords: tokenizeQuery(input.summary).slice(0, 12),
      relatedFiles: [],
    },
    validity: {
      status: "active",
      createdAt: now,
      updatedAt: now,
      confidence: input.evidenceIds?.length ? 0.8 : 0.62,
    },
    evidence: input.evidenceIds?.length
      ? { source: "test", evidenceIds: input.evidenceIds }
      : undefined,
  }
}

function capsuleSimilarity(a: MemoryCapsule, b: MemoryCapsule): number {
  const left = new Set(tokenizeQuery(`${a.title} ${a.content} ${a.retrieval.keywords.join(" ")}`))
  const right = new Set(tokenizeQuery(`${b.title} ${b.content} ${b.retrieval.keywords.join(" ")}`))
  if (!left.size || !right.size) return 0
  let overlap = 0
  for (const term of left) if (right.has(term)) overlap++
  return overlap / Math.max(left.size, right.size)
}

function isShortTermState(text: string): boolean {
  return /\b(current round|stdout|stderr|temporary|just now|this run only|短期|临时|刚才)\b/i.test(text)
}

function containsSensitiveMemory(text: string): boolean {
  return /api[_-]?key|password|secret|token\s*[:=]|BEGIN [A-Z ]+PRIVATE KEY/i.test(text)
}

// ── DeepSeek cache hit/miss telemetry ──

export type CacheTelemetryStatus = "hit" | "miss" | "partial"

export interface CacheTelemetryEntry {
  id: string
  timestamp: string
  provider: "deepseek" | "anthropic_compat" | "other"
  model: string
  round: number
  status: CacheTelemetryStatus
  hitRate: number
  stablePrefixChars: number
  changedSection?: string
}

export interface CacheTelemetrySummary {
  total: number
  hits: number
  misses: number
  partials: number
  averageHitRate: number
  unstableSections: Record<string, number>
}

export function recordCacheTelemetry(root: string, entry: Omit<CacheTelemetryEntry, "id" | "timestamp">): CacheTelemetryEntry {
  const dir = join(root, ".orcana", "state")
  mkdirSync(dir, { recursive: true })
  const full: CacheTelemetryEntry = {
    ...entry,
    id: `cache-${hashMemoryText(`${entry.model}:${entry.round}:${entry.status}:${entry.hitRate}`).slice(0, 12)}`,
    timestamp: new Date().toISOString(),
    hitRate: clamp01(entry.hitRate),
  }
  appendFileSync(join(dir, "cache-telemetry.jsonl"), JSON.stringify(full) + "\n", "utf-8")
  return full
}

export function summarizeCacheTelemetry(entries: CacheTelemetryEntry[]): CacheTelemetrySummary {
  const unstableSections: Record<string, number> = {}
  for (const entry of entries) {
    if (entry.changedSection) unstableSections[entry.changedSection] = (unstableSections[entry.changedSection] ?? 0) + 1
  }
  return {
    total: entries.length,
    hits: entries.filter(e => e.status === "hit").length,
    misses: entries.filter(e => e.status === "miss").length,
    partials: entries.filter(e => e.status === "partial").length,
    averageHitRate: entries.length ? Math.round((entries.reduce((sum, e) => sum + e.hitRate, 0) / entries.length) * 1000) / 1000 : 0,
    unstableSections,
  }
}

function sectionText(title: string, content?: string): string {
  const trimmed = content?.trim()
  return trimmed ? [`### ${title}`, trimmed].join("\n") : ""
}

function formatMemoryIndex(index?: MemoryIndex | string): string {
  if (!index) return ""
  if (typeof index === "string") return index
  return [
    `path: ${index.path}`,
    index.alwaysLoad.length ? `alwaysLoad: ${index.alwaysLoad.join(", ")}` : "",
    index.topicFiles.length ? `topicFiles: ${index.topicFiles.join(", ")}` : "",
    index.recentDecisions.length ? `recentDecisions: ${index.recentDecisions.slice(-5).join(" | ")}` : "",
  ].filter(Boolean).join("\n")
}

function truncateSection(content: string, maxChars: number): { content: string; truncated: boolean } {
  if (content.length <= maxChars) return { content, truncated: false }
  return {
    content: [
      content.slice(0, maxChars),
      "",
      `[truncated ${content.length - maxChars} chars; load source memory file only if needed]`,
    ].join("\n"),
    truncated: true,
  }
}

function hashMemoryText(text: string): string {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  const len = (text.length & 0xffff).toString(16).padStart(4, "0")
  return (hash >>> 0).toString(16).padStart(8, "0") + len
}
