/** Context compactor: progressive tiered storage.
 *
 * Hot turns stay in normal conversation history. Older turns are represented as
 * structured continuity notes while their raw content remains on disk/session
 * storage. This is not a lossy source of truth; it is a prompt-sized resume aid.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

interface Turn {
  role: "user" | "assistant"
  content: string
}

interface WarmRecord {
  index: number
  role: string
  gist: string
}

export interface M0BaseCheckpoint {
  id: string
  createdAt: number
  sourceTokens: number
  digest: string
  manifest: MemoryManifest
  archivePath?: string
}

export interface DeltaMemory {
  id: string
  createdAt: number
  title: string
  summary: string
  decisions: string[]
  filesTouched: string[]
  unresolvedObligations: string[]
  verifiedBy?: string
}

export interface MemoryManifest {
  topics: string[]
  filesTouched: string[]
  decisions: string[]
  unresolvedObligations: string[]
}

export interface ColdArchive {
  id: string
  path: string
  tokens: number
  createdAt: number
}

export interface CompactionState {
  hotTurns: Turn[]
  warmTurns: Turn[]
  warmRecords: WarmRecord[]
  coldDigest: {
    topics: string[]
    filesTouched: string[]
    decisions: string[]
  }
  anchor?: M0BaseCheckpoint
  deltas: DeltaMemory[]
  manifest: MemoryManifest
  archives: ColdArchive[]
  totalTurns: number
  estimatedTokens: number
  storeDir: string
}

export interface CompactionPreviewInput {
  sessionId?: string
  messageCount?: number
  loadedFiles?: string[]
}

export interface BaseCheckpointInput {
  sessionId?: string
  thresholdTokens?: number
  title?: string
  unresolvedObligations?: string[]
  activeDecisions?: string[]
}

export interface DeltaMemoryInput {
  title: string
  summary: string
  decisions?: string[]
  filesTouched?: string[]
  unresolvedObligations?: string[]
  verifiedBy?: string
}

export interface AnchorDeltaBudget {
  maxTokens?: number
  maxDeltas?: number
  maxWarmRecords?: number
}

const HOT_WINDOW = 20
const WARM_CAP = 40
const MAX_GIST_CHARS = 220
const FILE_RE = /\b[\w./-]+\.(py|ts|tsx|js|jsx|rs|go|json|toml|yaml|yml|md)\b/gi
const DECISION_RE = /\b(decided|decision|choose|chosen|must|should|do not|avoid|changed|fixed|implemented|completed|blocked|risk|todo|next)\b/i

export function createCompactor(storeDir?: string): CompactionState {
  const dir = storeDir ?? join(homedir(), ".orcana", "compactor")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return {
    hotTurns: [],
    warmTurns: [],
    warmRecords: [],
    coldDigest: { topics: [], filesTouched: [], decisions: [] },
    deltas: [],
    manifest: { topics: [], filesTouched: [], decisions: [], unresolvedObligations: [] },
    archives: [],
    totalTurns: 0,
    estimatedTokens: 0,
    storeDir: dir,
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3)
}

function uniqueAppend(items: string[], value: string, limit: number): string[] {
  const clean = value.trim()
  if (!clean) return items
  const without = items.filter(item => item !== clean)
  return [...without, clean].slice(-limit)
}

function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function extractFiles(text: string): string[] {
  const files: string[] = []
  for (const match of text.matchAll(FILE_RE)) files.push(match[0])
  return [...new Set(files)].slice(0, 6)
}

function extractDecision(text: string): string | null {
  const sentences = compactWhitespace(text).split(/(?<=[.!?;])\s+|\n+/)
  for (const sentence of sentences) {
    const clean = sentence.trim()
    if (clean.length >= 12 && clean.length <= 260 && DECISION_RE.test(clean)) return clean
  }
  return null
}

function turnToGist(turn: Turn): string {
  const role = turn.role === "user" ? "User" : "DS"
  const text = compactWhitespace(turn.content)
  const preview = text.length > MAX_GIST_CHARS ? `${text.slice(0, MAX_GIST_CHARS)}...` : text
  const files = extractFiles(text)
  const decision = extractDecision(text)
  const tags = [
    files.length ? `files=${files.join(", ")}` : "",
    decision ? `signal=${decision}` : "",
  ].filter(Boolean)

  return `${role}: ${preview}${tags.length ? ` [${tags.join(" | ")}]` : ""}`
}

function foldIntoColdDigest(state: CompactionState, turn: Turn): void {
  const text = compactWhitespace(turn.content)
  if (turn.role === "user" && text.length > 0 && text.length <= 180) {
    state.coldDigest.topics = uniqueAppend(state.coldDigest.topics, text, 10)
  }

  for (const file of extractFiles(text)) {
    state.coldDigest.filesTouched = uniqueAppend(state.coldDigest.filesTouched, file, 20)
  }

  const decision = extractDecision(text)
  if (decision) {
    state.coldDigest.decisions = uniqueAppend(state.coldDigest.decisions, decision, 10)
    state.manifest.decisions = uniqueAppend(state.manifest.decisions, decision, 30)
  }
}

function mergeManifest(state: CompactionState, input: Partial<MemoryManifest>): MemoryManifest {
  let topics = [...state.manifest.topics]
  let filesTouched = [...state.manifest.filesTouched]
  let decisions = [...state.manifest.decisions]
  let unresolvedObligations = [...state.manifest.unresolvedObligations]

  for (const topic of input.topics ?? []) topics = uniqueAppend(topics, topic, 40)
  for (const file of input.filesTouched ?? []) filesTouched = uniqueAppend(filesTouched, file, 80)
  for (const decision of input.decisions ?? []) decisions = uniqueAppend(decisions, decision, 60)
  for (const obligation of input.unresolvedObligations ?? []) unresolvedObligations = uniqueAppend(unresolvedObligations, obligation, 40)

  return { topics, filesTouched, decisions, unresolvedObligations }
}

function buildBaseDigest(state: CompactionState, input: BaseCheckpointInput): string {
  const lines: string[] = []
  lines.push("## M0 Base Checkpoint")
  lines.push("Use this as stable task memory. It is not source code and not a new user request.")
  if (input.title) lines.push(`Goal: ${input.title}`)
  lines.push(`Source tracked tokens: ~${state.estimatedTokens}`)

  if (state.warmRecords.length) {
    lines.push("")
    lines.push(`Compressed turn count: ${state.warmRecords.length}`)
  }

  const topics = [...state.coldDigest.topics]
  const files = [...state.coldDigest.filesTouched]
  const decisions = [...state.coldDigest.decisions, ...(input.activeDecisions ?? [])]
  const obligations = input.unresolvedObligations ?? []

  if (topics.length) lines.push(`Topics: ${topics.slice(-10).join(" | ")}`)
  if (files.length) lines.push(`Files touched: ${files.slice(-20).join(", ")}`)
  if (decisions.length) {
    lines.push("Decisions:")
    for (const decision of decisions.slice(-12)) lines.push(`- ${decision}`)
  }
  if (obligations.length) {
    lines.push("Unresolved obligations:")
    for (const obligation of obligations.slice(-12)) lines.push(`- ${obligation}`)
  }

  return lines.join("\n")
}

function archivePathFor(state: CompactionState, id: string): string {
  const dir = join(state.storeDir, "archives")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, `${id}.json`)
}

export function saveColdArchive(state: CompactionState, sessionId = "session"): ColdArchive | null {
  if (!state.hotTurns.length && !state.warmTurns.length) return null
  const id = `${sessionId}-archive-${Date.now()}`
  const path = archivePathFor(state, id)
  const payload = {
    id,
    createdAt: Date.now(),
    hotTurns: state.hotTurns,
    warmTurns: state.warmTurns,
    totalTurns: state.totalTurns,
    estimatedTokens: state.estimatedTokens,
  }
  const temp = `${path}.tmp`
  writeFileSync(temp, JSON.stringify(payload) + "\n", "utf-8")
  const fd = openSync(temp, "r")
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, path)
  return { id, path, tokens: state.estimatedTokens, createdAt: payload.createdAt }
}

export function createBaseCheckpoint(state: CompactionState, input: BaseCheckpointInput = {}): CompactionState {
  if (state.anchor) return state
  const threshold = input.thresholdTokens ?? 0
  if (state.estimatedTokens < threshold) return state

  const archive = saveColdArchive(state, input.sessionId ?? "m0")
  const digest = buildBaseDigest(state, input)
  const manifest = mergeManifest(state, {
    topics: state.coldDigest.topics,
    filesTouched: state.coldDigest.filesTouched,
    decisions: [...state.coldDigest.decisions, ...(input.activeDecisions ?? [])],
    unresolvedObligations: input.unresolvedObligations ?? [],
  })
  const anchor: M0BaseCheckpoint = {
    id: `${input.sessionId ?? "m0"}-${Date.now()}`,
    createdAt: Date.now(),
    sourceTokens: state.estimatedTokens,
    digest,
    manifest,
    archivePath: archive?.path,
  }

  return {
    ...state,
    anchor,
    manifest,
    archives: archive ? [...state.archives, archive] : [...state.archives],
  }
}

export function appendDeltaMemory(state: CompactionState, input: DeltaMemoryInput): CompactionState {
  const delta: DeltaMemory = {
    id: `delta-${Date.now()}-${state.deltas.length + 1}`,
    createdAt: Date.now(),
    title: compactWhitespace(input.title).slice(0, 140),
    summary: compactWhitespace(input.summary).slice(0, 2000),
    decisions: (input.decisions ?? []).map(item => compactWhitespace(item)).filter(Boolean).slice(0, 12),
    filesTouched: [...new Set(input.filesTouched ?? [])].slice(0, 30),
    unresolvedObligations: (input.unresolvedObligations ?? []).map(item => compactWhitespace(item)).filter(Boolean).slice(0, 20),
    verifiedBy: input.verifiedBy ? compactWhitespace(input.verifiedBy).slice(0, 240) : undefined,
  }
  const manifest = mergeManifest(state, {
    topics: [delta.title],
    filesTouched: delta.filesTouched,
    decisions: delta.decisions,
    unresolvedObligations: delta.unresolvedObligations,
  })
  return {
    ...state,
    deltas: [...state.deltas, delta],
    manifest,
  }
}

function pushWithinBudget(lines: string[], line: string, budget: number): boolean {
  const next = [...lines, line].join("\n")
  if (estimateTokens(next) > budget) return false
  lines.push(line)
  return true
}

export function buildAnchorDeltaContext(state: CompactionState, budget: AnchorDeltaBudget = {}): string {
  const maxTokens = budget.maxTokens ?? 30_000
  const maxDeltas = budget.maxDeltas ?? 5
  const lines: string[] = []

  if (state.anchor) {
    for (const line of state.anchor.digest.split("\n")) {
      if (!pushWithinBudget(lines, line, maxTokens)) return lines.join("\n")
    }
  }

  const manifestLines: string[] = []
  if (state.manifest.topics.length || state.manifest.filesTouched.length || state.manifest.decisions.length || state.manifest.unresolvedObligations.length) {
    manifestLines.push("")
    manifestLines.push("## Memory Manifest")
    if (state.manifest.topics.length) manifestLines.push(`- Topics: ${state.manifest.topics.slice(-12).join(" | ")}`)
    if (state.manifest.filesTouched.length) manifestLines.push(`- Files: ${state.manifest.filesTouched.slice(-20).join(", ")}`)
    if (state.manifest.decisions.length) manifestLines.push(`- Decisions: ${state.manifest.decisions.slice(-10).join(" | ")}`)
    if (state.manifest.unresolvedObligations.length) manifestLines.push(`- Unresolved: ${state.manifest.unresolvedObligations.slice(-10).join(" | ")}`)
  }
  for (const line of manifestLines) {
    if (!pushWithinBudget(lines, line, maxTokens)) return lines.join("\n")
  }

  const recentDeltas = state.deltas.slice(-maxDeltas)
  if (recentDeltas.length && !pushWithinBudget(lines, "\n## Recent Delta Memories", maxTokens)) return lines.join("\n")
  for (const delta of recentDeltas) {
    const block = [
      `- ${delta.title}: ${delta.summary}`,
      delta.decisions.length ? `  decisions: ${delta.decisions.join(" | ")}` : "",
      delta.filesTouched.length ? `  files: ${delta.filesTouched.join(", ")}` : "",
      delta.unresolvedObligations.length ? `  unresolved: ${delta.unresolvedObligations.join(" | ")}` : "",
      delta.verifiedBy ? `  verifiedBy: ${delta.verifiedBy}` : "",
    ].filter(Boolean)
    for (const line of block) {
      if (!pushWithinBudget(lines, line, maxTokens)) return lines.join("\n")
    }
  }

  return lines.join("\n")
}

export function buildStableAnchorContext(state: CompactionState, budget: AnchorDeltaBudget = {}): string {
  if (!state.anchor) return ""
  const maxTokens = budget.maxTokens ?? 30_000
  const lines: string[] = []
  for (const line of state.anchor.digest.split("\n")) {
    if (!pushWithinBudget(lines, line, maxTokens)) break
  }
  return lines.join("\n")
}

export function buildDynamicMemoryContext(state: CompactionState, budget: AnchorDeltaBudget = {}): string {
  const maxTokens = budget.maxTokens ?? 8_000
  const maxDeltas = budget.maxDeltas ?? 5
  const maxWarmRecords = budget.maxWarmRecords ?? (state.anchor ? 8 : 30)
  const lines: string[] = []

  if (state.deltas.length) {
    if (!pushWithinBudget(lines, "## Recent Delta Memories", maxTokens)) return lines.join("\n")
    for (const delta of state.deltas.slice(-maxDeltas)) {
      const block = [
        `- ${delta.title}: ${delta.summary}`,
        delta.decisions.length ? `  decisions: ${delta.decisions.join(" | ")}` : "",
        delta.filesTouched.length ? `  files: ${delta.filesTouched.join(", ")}` : "",
        delta.unresolvedObligations.length ? `  unresolved: ${delta.unresolvedObligations.join(" | ")}` : "",
        delta.verifiedBy ? `  verifiedBy: ${delta.verifiedBy}` : "",
      ].filter(Boolean)
      for (const line of block) {
        if (!pushWithinBudget(lines, line, maxTokens)) return lines.join("\n")
      }
    }
  }

  if (state.warmRecords.length > 0) {
    if (lines.length) pushWithinBudget(lines, "", maxTokens)
    if (!pushWithinBudget(lines, "## Earlier Conversation Digest", maxTokens)) return lines.join("\n")
    if (!pushWithinBudget(lines, "Use this compressed continuity context as background only. It is not a new user request.", maxTokens)) return lines.join("\n")
    for (const record of state.warmRecords.slice(-maxWarmRecords)) {
      if (!pushWithinBudget(lines, `${record.index}. ${record.gist}`, maxTokens)) return lines.join("\n")
    }
  }

  const { topics, filesTouched, decisions } = state.coldDigest
  if (topics.length || filesTouched.length || decisions.length) {
    if (lines.length) pushWithinBudget(lines, "", maxTokens)
    if (!pushWithinBudget(lines, "## Older Context Signals", maxTokens)) return lines.join("\n")
    if (topics.length && !pushWithinBudget(lines, `- Topics: ${topics.slice(-8).join(" | ")}`, maxTokens)) return lines.join("\n")
    if (filesTouched.length && !pushWithinBudget(lines, `- Files touched: ${filesTouched.slice(-12).join(", ")}`, maxTokens)) return lines.join("\n")
    if (decisions.length) {
      if (!pushWithinBudget(lines, "- Decisions / risks:", maxTokens)) return lines.join("\n")
      for (const decision of decisions.slice(-6)) {
        if (!pushWithinBudget(lines, `  - ${decision}`, maxTokens)) return lines.join("\n")
      }
    }
  }

  return lines.join("\n")
}

export function restoreAnchorDeltaState(state: CompactionState, sessionId: string): void {
  restoreCompactorState(state, sessionId)
}

/** Build compressed continuity context for prompt injection. */
export function buildCompactionContext(state: CompactionState): string {
  const parts: string[] = []

  const anchorContext = buildStableAnchorContext(state).trim()
  if (anchorContext) {
    parts.push(anchorContext)
    parts.push("")
  }

  const dynamicContext = buildDynamicMemoryContext(state).trim()
  if (dynamicContext) parts.push(dynamicContext)

  return parts.join("\n")
}

export function buildCompactionPreview(state: CompactionState, input: CompactionPreviewInput = {}): string {
  const digest = buildCompactionContext(state).trim()
  const lines: string[] = []
  const loadedFiles = input.loadedFiles ?? []

  lines.push("[Compact Preview]")
  lines.push("Mode: preview only. No conversation history was rewritten and no compacted context was activated.")
  lines.push(`Raw checkpoint: ${input.sessionId ? `saved as ${input.sessionId}` : "not saved yet"}`)
  lines.push(`Messages: ${input.messageCount ?? 0}`)
  lines.push(`Turns tracked: ${state.totalTurns} total | ${state.hotTurns.length} hot raw | ${state.warmTurns.length} warm raw | ${state.warmRecords.length} warm digest`)
  lines.push(`Estimated tracked tokens: ~${state.estimatedTokens}`)
  lines.push(`Loaded files: ${loadedFiles.length ? loadedFiles.slice(0, 12).join(", ") : "(none)"}`)
  lines.push(`M0 anchor: ${state.anchor ? `${state.anchor.id} (~${estimateTokens(state.anchor.digest)} tokens)` : "(not created)"}`)
  lines.push(`Delta memories: ${state.deltas.length}`)
  lines.push(`Manifest: ${state.manifest.topics.length} topics | ${state.manifest.filesTouched.length} files | ${state.manifest.decisions.length} decisions | ${state.manifest.unresolvedObligations.length} unresolved`)
  lines.push(`Raw archives: ${state.archives.length ? state.archives.map(archive => archive.id).slice(-3).join(", ") : "(none)"}`)
  lines.push("")

  if (digest) {
    lines.push("## Previewed Continuity Context")
    lines.push(digest)
  } else {
    lines.push("## Previewed Continuity Context")
    lines.push("(empty; not enough old turns have moved into compacted tiers yet)")
  }

  lines.push("")
  lines.push("## Safety Notes")
  lines.push("- Raw recent turns remain in normal conversation history.")
  lines.push("- Warm raw turns remain in memory and are persisted with the session checkpoint.")
  lines.push("- Raw archives stay on disk and are not injected into the prompt.")
  lines.push("- M0 stays stable; future compactions append deltas instead of rewriting it.")
  lines.push("- This preview should be inspected before enabling automatic compaction.")

  return lines.join("\n")
}

export function addTurn(state: CompactionState, turn: Turn): CompactionState {
  const next: CompactionState = {
    ...state,
    hotTurns: [...state.hotTurns, turn],
    warmTurns: [...state.warmTurns],
    warmRecords: [...state.warmRecords],
    coldDigest: {
      topics: [...state.coldDigest.topics],
      filesTouched: [...state.coldDigest.filesTouched],
      decisions: [...state.coldDigest.decisions],
    },
    anchor: state.anchor ? { ...state.anchor, manifest: { ...state.anchor.manifest } } : undefined,
    deltas: state.deltas.map(delta => ({ ...delta, decisions: [...delta.decisions], filesTouched: [...delta.filesTouched], unresolvedObligations: [...delta.unresolvedObligations] })),
    manifest: {
      topics: [...state.manifest.topics],
      filesTouched: [...state.manifest.filesTouched],
      decisions: [...state.manifest.decisions],
      unresolvedObligations: [...state.manifest.unresolvedObligations],
    },
    archives: state.archives.map(archive => ({ ...archive })),
    totalTurns: state.totalTurns + 1,
    estimatedTokens: state.estimatedTokens + estimateTokens(turn.content),
  }

  while (next.hotTurns.length > HOT_WINDOW) {
    const oldest = next.hotTurns.shift()!
    next.warmTurns.push(oldest)
    next.warmRecords.push({
      index: next.totalTurns - next.hotTurns.length,
      role: oldest.role,
      gist: turnToGist(oldest),
    })
  }

  while (next.warmTurns.length > WARM_CAP) {
    const oldest = next.warmTurns.shift()!
    next.warmRecords.shift()
        foldIntoColdDigest(next, oldest)
  }

  for (const file of extractFiles(turn.content)) {
    next.manifest.filesTouched = uniqueAppend(next.manifest.filesTouched, file, 80)
  }

  return next
}

export function saveCompactorState(state: CompactionState, sessionId: string) {
  try {
    const path = join(state.storeDir, `${sessionId}.json`)
    const temp = join(state.storeDir, `${sessionId}.json.tmp`)
    const data = {
      sessionId,
      timestamp: Date.now(),
      hotTurns: state.hotTurns,
      warmTurns: state.warmTurns,
      warmRecords: state.warmRecords,
      coldDigest: state.coldDigest,
      anchor: state.anchor,
      deltas: state.deltas,
      manifest: state.manifest,
      archives: state.archives,
      totalTurns: state.totalTurns,
      estimatedTokens: state.estimatedTokens,
    }
    writeFileSync(temp, JSON.stringify(data), "utf-8")
    renameSync(temp, path)
  } catch {
    // Best-effort persistence; session save should not fail because of compactor storage.
  }
}

// ── Thinking Chain Compaction ──

export interface ThinkingRoundInput {
  roundNum: number
  thinking: string
  toolsUsed: string[]
  hadError: boolean
}

export interface CompactThinkingResult {
  output: {
    key_insights: string[]
    discarded: string[]
    verified: string[]
    open: string[]
  }
  success: boolean
  error?: string
}

/** Call DeepSeek Flash to distill multi-round thinking chains into structured insights. */
export async function compactThinkingChain(
  rounds: ThinkingRoundInput[],
  streamChat: (system: string, prompt: string) => AsyncGenerator<{ type: string; data?: unknown }>,
): Promise<CompactThinkingResult> {
  if (!rounds.length) {
    return { output: { key_insights: [], discarded: [], verified: [], open: [] }, success: true }
  }

  const roundText = rounds.map(r => {
    const tools = r.toolsUsed.length ? ` · 工具: ${r.toolsUsed.join(", ")}` : ""
    const err = r.hadError ? " ⚠️ 有错误" : ""
    return `Round ${r.roundNum}${tools}${err}:\n⟨think⟩\n${r.thinking.slice(0, 4000)}\n⟨/think⟩`
  }).join("\n\n")

  const prompt = [
    "把以下多轮深度推理链精炼为核心洞察。返回严格 JSON。",
    "",
    "规则:",
    '- "key_insights": 对当前任务仍有价值的发现（每项 ≤50字，最多 5 条）',
    '- "discarded": 已被自己推翻的假设或分析，说明为什么推翻（每项 ≤50字，最多 3 条）',
    '- "verified": 已被验证正确的结论（每项 ≤50字，最多 3 条）',
    '- "open": 尚未解决的问题，下一轮需要面对（每项 ≤50字，最多 3 条）',
    "- 如果某类别没有内容，返回空数组",
    "- 只保留仍然 relevant 的信息",
    "- 用中文",
    "",
    "输出纯 JSON，不要其他文字。",
    "",
    "## 推理链",
    roundText,
  ].join("\n")

  try {
    const chunks: string[] = []
    for await (const event of streamChat(
      "你是推理链压缩器。输出纯 JSON。",
      prompt,
    )) {
      if (event.type === "text" && typeof event.data === "string") {
        chunks.push(event.data)
      }
    }

    const text = chunks.join("").trim()
    // Extract JSON from response (may have markdown fences)
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return { output: { key_insights: [], discarded: [], verified: [], open: [] }, success: false, error: `No JSON found in: ${text.slice(0, 200)}` }
    }

    const parsed = JSON.parse(jsonMatch[0]) as CompactThinkingResult["output"]
    return {
      output: {
        key_insights: Array.isArray(parsed.key_insights) ? parsed.key_insights.slice(0, 5) : [],
        discarded: Array.isArray(parsed.discarded) ? parsed.discarded.slice(0, 3) : [],
        verified: Array.isArray(parsed.verified) ? parsed.verified.slice(0, 3) : [],
        open: Array.isArray(parsed.open) ? parsed.open.slice(0, 3) : [],
      },
      success: true,
    }
  } catch (e) {
    return { output: { key_insights: [], discarded: [], verified: [], open: [] }, success: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function restoreCompactorState(state: CompactionState, sessionId: string) {
  try {
    const path = join(state.storeDir, `${sessionId}.json`)
    if (!existsSync(path)) return
    // Parse full JSON file (no line-splitting — avoids corruption when strings contain newlines)
    const raw = readFileSync(path, "utf-8")
    // Try the atomic temp file first if the main one fails
    let last: Partial<CompactionState> & { hotTurns?: Turn[] }
    try {
      last = JSON.parse(raw) as typeof last
    } catch {
      const tempPath = join(state.storeDir, `${sessionId}.json.tmp`)
      if (existsSync(tempPath)) {
        last = JSON.parse(readFileSync(tempPath, "utf-8")) as typeof last
      } else {
        return
      }
    }
    state.hotTurns = last.hotTurns ?? []
    state.warmTurns = last.warmTurns ?? []
    state.warmRecords = last.warmRecords ?? []
    state.coldDigest = last.coldDigest ?? { topics: [], filesTouched: [], decisions: [] }
    state.anchor = last.anchor
    state.deltas = last.deltas ?? []
    state.manifest = last.manifest ?? { topics: [], filesTouched: [], decisions: [], unresolvedObligations: [] }
    state.archives = last.archives ?? []
    state.totalTurns = last.totalTurns ?? 0
    state.estimatedTokens = last.estimatedTokens ?? state.warmTurns.reduce((sum, turn) => sum + estimateTokens(turn.content), 0)
  } catch {
    // Ignore corrupt/missing compactor state; normal session resume still works.
  }
}
