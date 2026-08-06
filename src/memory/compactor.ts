/** Context compactor: progressive tiered storage.
 *
 * Hot turns stay in normal conversation history. Older turns are represented as
 * structured continuity notes while their raw content remains on disk/session
 * storage. This is not a lossy source of truth; it is a prompt-sized resume aid.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

interface Turn {
  role: "user" | "assistant"
  content: string
}

/** K13: structured decision signal with confidence + source line reference. */
export interface DecisionSignal {
  text: string
  confidence: number
  source: "header" | "verb-phrase" | "signal-word"
  /** 1-based source line within the original turn content. */
  line: number
  /** K13/K18: corroborating evidence (tool result / passed verification). */
  evidence?: string[]
}

interface WarmRecord {
  index: number
  role: string
  gist: string
  /** K13: structured extraction kept with the gist (index layer). */
  signals?: DecisionSignal[]
  /** K13/K18: corroborated by tool result or passed verification. */
  verified?: boolean
}

/** K15: one entry of the omission manifest — evictions are never silent. */
export interface OmittedEntry {
  gist: string
  reason: "cap" | "conflict" | "age"
  index: number
  at: number
}

/** K18: optional Agent-internal run trajectory the compactor can use for
 * decision extraction corroboration and fact provenance. Not wiring it in is
 * fully supported — every use is guarded by `?? []`/`=== undefined`. */
export interface RunTrajectory {
  toolCalls?: Array<{ name: string; ok: boolean; summary?: string }>
  verifications?: Array<{ kind: string; passed: boolean; atRound?: number }>
  gateBlocks?: Array<{ gate: string; round?: number }>
}

/** K18: optional per-turn trajectory input for addTurn. */
export interface AddTurnOptions {
  trajectory?: RunTrajectory
}

export interface M0BaseCheckpoint {
  id: string
  createdAt: number
  sourceTokens: number
  digest: string
  manifest: MemoryManifest
  archivePath?: string
  /** K12: anchor audit trail — version bumps on every correction/supersede. */
  anchorVersion?: number
  /** K12: id of the anchor this one supersedes (audit trail). */
  supersedesId?: string
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
  /** K15: omission manifest — every cap/conflict/age eviction is recorded. */
  omitted: OmittedEntry[]
  /** K16: raw turns folded out of the warm tier, kept so cold archives can
   * always serialize the complete original message sequence. */
  coldRawTurns: Turn[]
  /** K18: parallel queue to hotTurns — the trajectory supplied when each hot
   * turn was added, so the warm-tier analysis at shift time can corroborate
   * with the evidence that was current for that turn. */
  hotTrajectories: Array<RunTrajectory | undefined>
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
  /** K12: force a supersede/correction of an existing M0 anchor. */
  supersede?: boolean
  /** K18: run trajectory evidence folded into the anchor digest. */
  trajectory?: RunTrajectory
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
const GIST_HEAD_BUDGET = Math.floor(MAX_GIST_CHARS * 0.6)
const ELLIPSIS = "…"
const FILE_RE = /\b[\w./-]+\.(py|ts|tsx|js|jsx|rs|go|json|toml|yaml|yml|md)\b/gi
const DECISION_RE = /\b(decided|decision|choose|chosen|must|should|do not|avoid|changed|fixed|implemented|completed|blocked|risk|todo|next)\b/i
// K13: structured extraction — high-confidence title lines and verb phrases.
// Verb patterns capture the verb + its clause as one phrase so the extracted
// decision reads naturally ("我决定不再用 webpack"), with a {4,} clause floor
// to keep bare-verb false positives out. No leading \b: CJK chars are not \w,
// so a word boundary never exists before them.
const DECISION_HEADER_RE = /^\s*(?:决定|决策|决定事项|结论|Decision|Decided)\s*[:：]\s*(.+)$/i
const DECISION_VERB_HIGH_RE = /((?:我决定|我们决定|决定采用|不再用|放弃|改为|决定弃用)\s*[:：]?\s*[^。；;.!?！？]{4,})/i
const DECISION_VERB_LOW_RE = /((?:决定|采用|选择|改用|坚持|切换|迁移到|确定用|避免)\s*[:：]?\s*[^。；;.!?！？]{4,})/i
// K13/K18: tool-result corroboration ("typecheck 通过 / 测试绿 / passed").
const TOOL_EVIDENCE_RE = /\b(typecheck|bun test|build|passed|passing|green|通过|成功|verified|test pass)\b/i

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
    omitted: [],
    coldRawTurns: [],
    hotTrajectories: [],
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

/** K13: structured decision extraction with confidence + source line reference.
 * Higher recall than the old single-regex pass while keeping precision tiers:
 * 1.0 title header, 0.85 strong verb phrase, 0.6 verb phrase, 0.45 signal word.
 * Tool-result corroboration (typecheck/tests passing) raises confidence. */
function extractSignals(text: string, trajectory?: RunTrajectory): DecisionSignal[] {
  const signals: DecisionSignal[] = []
  const lines = compactWhitespace(text).split(/\n+/)

  const pushSignal = (rawText: string, confidence: number, source: DecisionSignal["source"], line: number) => {
    const clean = compactWhitespace(rawText)
    if (!clean || clean.length < 6 || clean.length > 260) return
    const evidence: string[] = []
    if (TOOL_EVIDENCE_RE.test(clean) || TOOL_EVIDENCE_RE.test(text)) evidence.push("tool-result")
    if (trajectory?.verifications?.some(v => v.passed)) evidence.push("verification-passed")
    if (trajectory?.toolCalls?.some(tc => tc.ok)) evidence.push("tool-call-ok")
    const boost = evidence.length ? 0.15 : 0
    signals.push({
      text: clean,
      confidence: Math.min(1, confidence + boost),
      source,
      line,
      evidence: evidence.length ? evidence : undefined,
    })
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (!line) continue
    const lineNo = i + 1
    const header = line.match(DECISION_HEADER_RE)
    if (header?.[1]) {
      pushSignal(header[1], 1, "header", lineNo)
      continue
    }
    const high = line.match(DECISION_VERB_HIGH_RE)
    if (high?.[1]) {
      pushSignal(high[1], 0.85, "verb-phrase", lineNo)
      continue
    }
    const low = line.match(DECISION_VERB_LOW_RE)
    if (low?.[1]) {
      pushSignal(low[1], 0.6, "verb-phrase", lineNo)
      continue
    }
    if (DECISION_RE.test(line) && line.length >= 12 && line.length <= 260) {
      pushSignal(line, 0.45, "signal-word", lineNo)
    }
  }

  // Dedup by text, highest confidence first.
  const seen = new Set<string>()
  return signals
    .filter(s => (seen.has(s.text) ? false : (seen.add(s.text), true)))
    .sort((a, b) => b.confidence - a.confidence || a.line - b.line)
}

function topSignal(signals: DecisionSignal[]): DecisionSignal | null {
  return signals.length ? signals[0]! : null
}

/** K14: keep head + tail within the gist budget; never truncate the tail away.
 * Cuts the head at a sentence boundary when possible, keeps the last
 * `max - head - ellipsis` chars, joins with a mid-ellipsis and marks the cut. */
function truncateKeepTail(text: string, max: number = MAX_GIST_CHARS): { preview: string; truncated: boolean } {
  if (text.length <= max) return { preview: text, truncated: false }
  let headEnd = Math.min(GIST_HEAD_BUDGET, max)
  for (let i = headEnd - 1; i >= Math.max(0, headEnd - 24); i--) {
    if (/[。！？!?；;.]/.test(text[i]!)) {
      headEnd = i + 1
      break
    }
  }
  const tailBudget = max - headEnd - ELLIPSIS.length
  if (tailBudget < 24) {
    // Degenerate budget: fall back to head truncation so the preview stays useful.
    return { preview: `${text.slice(0, max)}…`, truncated: true }
  }
  return { preview: `${text.slice(0, headEnd)}${ELLIPSIS}${text.slice(text.length - tailBudget)}`, truncated: true }
}

/** K13/K18: analyze a turn into preview + structured signals + verified flag. */
function analyzeTurn(turn: Turn, trajectory?: RunTrajectory): { signals: DecisionSignal[]; verified: boolean } {
  const text = compactWhitespace(turn.content)
  const signals = extractSignals(text, trajectory)
  const verified = turn.role === "assistant" && (trajectory?.verifications?.some(v => v.passed) === true)
  return { signals, verified }
}

/** K13/K14: build the gist line for a warm turn (head+tail kept, signals tagged). */
function gistForTurn(turn: Turn, trajectory?: RunTrajectory): string {
  const role = turn.role === "user" ? "User" : "DS"
  const text = compactWhitespace(turn.content)
  const { preview, truncated } = truncateKeepTail(text)
  const files = extractFiles(text)
  const { signals, verified } = analyzeTurn(turn, trajectory)
  const decision = topSignal(signals)
  const tags = [
    files.length ? `files=${files.join(", ")}` : "",
    decision ? `signal=${decision.text}` : "",
    verified ? "verified" : "",
    truncated ? "mid-truncated" : "",
  ].filter(Boolean)

  return `${role}: ${preview}${tags.length ? ` [${tags.join(" | ")}]` : ""}`
}

function foldIntoColdDigest(state: CompactionState, turn: Turn, trajectory?: RunTrajectory): void {
  const text = compactWhitespace(turn.content)
  if (turn.role === "user" && text.length > 0 && text.length <= 180) {
    state.coldDigest.topics = uniqueAppend(state.coldDigest.topics, text, 10)
  }

  for (const file of extractFiles(text)) {
    state.coldDigest.filesTouched = uniqueAppend(state.coldDigest.filesTouched, file, 20)
  }

  const signals = extractSignals(text, trajectory)
  const decision = topSignal(signals)
  if (decision) {
    state.coldDigest.decisions = uniqueAppend(state.coldDigest.decisions, decision.text, 10)
    state.manifest.decisions = uniqueAppend(state.manifest.decisions, decision.text, 30)
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

function buildBaseDigest(
  state: CompactionState,
  input: BaseCheckpointInput & { extraDecisions?: string[]; extraObligations?: string[] },
): string {
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
  // K12: on supersede, the previous anchor's accumulated material is merged in.
  const decisions = [...state.coldDigest.decisions, ...(input.extraDecisions ?? []), ...(input.activeDecisions ?? [])]
  const obligations = [...(input.extraObligations ?? []), ...(input.unresolvedObligations ?? [])]

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

  // K18: trajectory evidence — passed verifications prove "resolved" instead of
  // relying on time decay; every fact line is traceable to the run.
  if (input.trajectory) {
    const passed = (input.trajectory.verifications ?? []).filter(v => v.passed)
    const okTools = (input.trajectory.toolCalls ?? []).filter(t => t.ok).length
    const gateBlocks = input.trajectory.gateBlocks?.length ?? 0
    if (passed.length || okTools || gateBlocks) {
      lines.push("")
      lines.push("Trajectory evidence:")
      lines.push(`- ${passed.length} verification(s) passed | ${okTools} tool call(s) ok | ${gateBlocks} gate block(s)`)
      for (const v of passed.slice(-3)) {
        lines.push(`  - ${v.kind} passed (round ${v.atRound ?? "?"})`)
      }
    }
  }

  return lines.join("\n")
}

function titleFromDigest(digest: string): string | undefined {
  const match = digest.match(/^Goal: (.+)$/m)
  return match?.[1]
}

function archivePathFor(state: CompactionState, id: string): string {
  const dir = join(state.storeDir, "archives")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, `${id}.json`)
}

export function saveColdArchive(state: CompactionState, sessionId = "session"): ColdArchive | null {
  if (!state.hotTurns.length && !state.warmTurns.length && !state.coldRawTurns.length) return null
  const id = `${sessionId}-archive-${Date.now()}`
  const path = archivePathFor(state, id)
  const payload = {
    id,
    createdAt: Date.now(),
    // K16: complete original raw message sequence (raw is the source of truth)…
    turns: [...state.coldRawTurns, ...state.warmTurns, ...state.hotTurns],
    // …plus the per-turn gist map (gist is the index).
    gists: state.warmRecords,
    omitted: state.omitted,
    // Retained for backward compatibility with any prior reader.
    hotTurns: state.hotTurns,
    warmTurns: state.warmTurns,
    warmRecords: state.warmRecords,
    totalTurns: state.totalTurns,
    estimatedTokens: state.estimatedTokens,
  }
  // K16: atomic write — temp file + fsync + rename; failure never leaves a
  // half-written file at the final path (temp is cleaned up on error).
  const temp = `${path}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(payload) + "\n", "utf-8")
    const fd = openSync(temp, "r")
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, path)
  } catch (error) {
    try {
      if (existsSync(temp)) rmSync(temp)
    } catch {
      // Best-effort cleanup; the final path is still untouched.
    }
    throw error
  }
  return { id, path, tokens: state.estimatedTokens, createdAt: payload.createdAt }
}

export function createBaseCheckpoint(state: CompactionState, input: BaseCheckpointInput = {}): CompactionState {
  const threshold = input.thresholdTokens ?? 0
  if (state.estimatedTokens < threshold) return state

  const existing = state.anchor
  if (existing) {
    // K12: M0 must be correctable. Supersede when explicitly requested, or when
    // the input carries genuinely new decisions/obligations (the "late find"
    // case). With no new input the anchor stays untouched (default behavior).
    const newDecisions = (input.activeDecisions ?? []).filter(decision => !state.manifest.decisions.includes(decision))
    const newObligations = (input.unresolvedObligations ?? []).filter(obligation => !state.manifest.unresolvedObligations.includes(obligation))
    const hasNewMaterial = newDecisions.length > 0 || newObligations.length > 0
    if (!input.supersede && !hasNewMaterial) return state

    const archive = saveColdArchive(state, input.sessionId ?? "m0")
    const digest = buildBaseDigest(state, {
      ...input,
      title: input.title ?? titleFromDigest(existing.digest),
      // Merge the previous anchor's accumulated material into the new digest.
      extraDecisions: existing.manifest.decisions,
      extraObligations: existing.manifest.unresolvedObligations,
    })
    const manifest = mergeManifest(state, {
      topics: state.coldDigest.topics,
      filesTouched: state.coldDigest.filesTouched,
      decisions: [...state.coldDigest.decisions, ...(input.activeDecisions ?? [])],
      unresolvedObligations: [...existing.manifest.unresolvedObligations, ...(input.unresolvedObligations ?? [])],
    })
    const anchor: M0BaseCheckpoint = {
      id: `${input.sessionId ?? "m0"}-${Date.now()}`,
      createdAt: Date.now(),
      sourceTokens: state.estimatedTokens,
      digest,
      manifest,
      archivePath: archive?.path ?? existing.archivePath,
      anchorVersion: (existing.anchorVersion ?? 1) + 1,
      supersedesId: existing.id,
    }

    return {
      ...state,
      anchor,
      manifest,
      archives: archive ? [...state.archives, archive] : [...state.archives],
    }
  }

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
    anchorVersion: 1,
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
  let memoryOmitted = 0

  // K17: reserve a guaranteed floor for the real conversation digest — the
  // last 2 warm rounds (or 30% of the budget, whichever is smaller) can never
  // be squeezed out by memory sections. Default budgets are large enough that
  // this reservation changes nothing when nothing is tight.
  const records = state.warmRecords.slice(-maxWarmRecords)
  let floorTokens = 0
  if (records.length) {
    const lastTwo = records.slice(-2)
    const floorBlock = [
      "## Earlier Conversation Digest",
      "Use this compressed continuity context as background only. It is not a new user request.",
      ...lastTwo.map(record => `${record.index}. ${record.gist}`),
    ].join("\n")
    floorTokens = Math.min(Math.floor(maxTokens * 0.3), estimateTokens(floorBlock))
  }
  const memoryBudget = Math.max(0, maxTokens - floorTokens)

  // 1) Recent delta memories — bounded by memoryBudget so the conversation
  //    floor is never consumed here. Trims are counted, never silent.
  if (state.deltas.length) {
    if (!pushWithinBudget(lines, "## Recent Delta Memories", memoryBudget)) {
      memoryOmitted += state.deltas.length
    } else {
      const selected = state.deltas.slice(-maxDeltas)
      for (let i = 0; i < selected.length; i++) {
        const delta = selected[i]!
        const block = [
          `- ${delta.title}: ${delta.summary}`,
          delta.decisions.length ? `  decisions: ${delta.decisions.join(" | ")}` : "",
          delta.filesTouched.length ? `  files: ${delta.filesTouched.join(", ")}` : "",
          delta.unresolvedObligations.length ? `  unresolved: ${delta.unresolvedObligations.join(" | ")}` : "",
          delta.verifiedBy ? `  verifiedBy: ${delta.verifiedBy}` : "",
        ].filter(Boolean)
        let fit = true
        for (const line of block) {
          if (!pushWithinBudget(lines, line, memoryBudget)) {
            fit = false
            break
          }
        }
        if (!fit) {
          memoryOmitted += selected.length - i
          break
        }
      }
    }
  }

  // 2) Older context signals (cold digest) — bounded by memoryBudget too.
  const { topics, filesTouched, decisions } = state.coldDigest
  if (topics.length || filesTouched.length || decisions.length) {
    if (lines.length) pushWithinBudget(lines, "", memoryBudget)
    if (pushWithinBudget(lines, "## Older Context Signals", memoryBudget)) {
      if (topics.length && !pushWithinBudget(lines, `- Topics: ${topics.slice(-8).join(" | ")}`, memoryBudget)) memoryOmitted++
      if (filesTouched.length && !pushWithinBudget(lines, `- Files touched: ${filesTouched.slice(-12).join(", ")}`, memoryBudget)) memoryOmitted++
      if (decisions.length) {
        if (!pushWithinBudget(lines, "- Decisions / risks:", memoryBudget)) {
          memoryOmitted += decisions.length
        } else {
          for (const decision of decisions.slice(-6)) {
            if (!pushWithinBudget(lines, `  - ${decision}`, memoryBudget)) {
              memoryOmitted++
              break
            }
          }
        }
      }
    } else {
      memoryOmitted++
    }
  }

  // 3) Earlier conversation digest — the guaranteed floor lives here. When the
  //    budget is tight, oldest records are dropped first, never the newest two.
  if (records.length) {
    if (lines.length) pushWithinBudget(lines, "", maxTokens)
    if (pushWithinBudget(lines, "## Earlier Conversation Digest", maxTokens)) {
      pushWithinBudget(lines, "Use this compressed continuity context as background only. It is not a new user request.", maxTokens)
      let remaining = records.slice()
      while (
        remaining.length > 2 &&
        estimateTokens([...lines, ...remaining.map(record => `${record.index}. ${record.gist}`)].join("\n")) > maxTokens
      ) {
        remaining.shift()
      }
      for (let i = 0; i < remaining.length; i++) {
        const line = `${remaining[i]!.index}. ${remaining[i]!.gist}`
        if (pushWithinBudget(lines, line, maxTokens)) continue
        if (remaining.length - i <= 2) lines.push(line) // floor is sacred: keep the last 2
      }
    }
  }

  // K17: trims of memory are announced in the injected text, never silent.
  if (memoryOmitted > 0) {
    lines.push(`- 已省略 ${memoryOmitted} 条记忆：budget`)
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

  // K15: evictions are injected into the context, never silent. Backward
  // compatible — this section only appears once the omission manifest has
  // entries.
  const omissions = state.omitted
  if (omissions.length) {
    const reasons = [...new Set(omissions.map(entry => entry.reason))]
    parts.push("")
    parts.push("## Memory Omissions")
    parts.push(`- 已省略 ${omissions.length} 条因上限 (${reasons.join("/")})`)
    for (const entry of omissions.slice(-3)) {
      parts.push(`  - [${entry.reason}] ${entry.gist.slice(0, 80)}`)
    }
  }

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
  lines.push(`Omission manifest: ${state.omitted.length} entries${state.omitted.length ? `; latest: "${state.omitted.at(-1)!.gist.slice(0, 60)}"` : ""}`)
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
  lines.push("- M0 can be superseded with corrections (anchorVersion/supersedesId audit trail); unchanged without new input.")
  lines.push("- Evictions from fixed caps are recorded in the omission manifest — nothing is dropped silently.")
  lines.push("- This preview should be inspected before enabling automatic compaction.")

  return lines.join("\n")
}

export function addTurn(state: CompactionState, turn: Turn, options: AddTurnOptions = {}): CompactionState {
  const next: CompactionState = {
    ...state,
    hotTurns: [...state.hotTurns, turn],
    // K18: keep the trajectory with its turn so the shift-time analysis can
    // corroborate with the evidence that was current when the turn was added.
    hotTrajectories: [...state.hotTrajectories, options.trajectory],
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
    omitted: [...state.omitted],
    coldRawTurns: [...state.coldRawTurns],
    totalTurns: state.totalTurns + 1,
    estimatedTokens: state.estimatedTokens + estimateTokens(turn.content),
  }

  const trajectory = options.trajectory

  while (next.hotTurns.length > HOT_WINDOW) {
    const oldest = next.hotTurns.shift()!
    const oldestTrajectory = next.hotTrajectories.shift()
    next.warmTurns.push(oldest)
    const analysis = analyzeTurn(oldest, oldestTrajectory)
    next.warmRecords.push({
      index: next.totalTurns - next.hotTurns.length,
      role: oldest.role,
      gist: gistForTurn(oldest, oldestTrajectory),
      signals: analysis.signals,
      verified: analysis.verified,
    })
  }

  // K15: cap evictions are never silent — evict by value (not mechanical tail),
  // record every eviction in the omission manifest, keep the raw turn for K16.
  while (next.warmTurns.length > WARM_CAP) {
    const evictAt = lowestValueWarmIndex(next.warmTurns, next.warmRecords)
    const [oldest] = next.warmTurns.splice(evictAt, 1)
    const [record] = next.warmRecords.splice(evictAt, 1)
    const evicted = oldest!
    next.coldRawTurns.push(evicted)
    foldIntoColdDigest(next, evicted, trajectory)
    next.omitted.push({
      gist: record?.gist ?? `${evicted.role}: ${compactWhitespace(evicted.content).slice(0, 120)}`,
      reason: "cap",
      index: record?.index ?? -1,
      at: Date.now(),
    })
  }

  for (const file of extractFiles(turn.content)) {
    next.manifest.filesTouched = uniqueAppend(next.manifest.filesTouched, file, 80)
  }

  return next
}

/** K15: value score for a warm turn — signal-bearing, evidenced and longer
 * turns survive the cap; ties break toward the oldest. */
function warmValueScore(turn: Turn, record: WarmRecord | undefined): number {
  const text = compactWhitespace(turn.content)
  let score = 1
  if (record?.signals?.length) score += record.signals.length * 2
  if (record?.verified) score += 3
  if (extractFiles(text).length) score += 1
  if (text.length >= 40) score += 1
  return score
}

function lowestValueWarmIndex(warmTurns: Turn[], warmRecords: WarmRecord[]): number {
  let lowest = 0
  let lowestScore = Infinity
  for (let i = 0; i < warmTurns.length; i++) {
    const score = warmValueScore(warmTurns[i]!, warmRecords[i])
    if (score < lowestScore) {
      lowestScore = score
      lowest = i
    }
  }
  return lowest
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
      omitted: state.omitted,
      coldRawTurns: state.coldRawTurns,
      hotTrajectories: state.hotTrajectories,
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
    state.omitted = last.omitted ?? []
    state.coldRawTurns = last.coldRawTurns ?? []
    state.hotTrajectories = last.hotTrajectories ?? []
    state.totalTurns = last.totalTurns ?? 0
    state.estimatedTokens = last.estimatedTokens ?? state.warmTurns.reduce((sum, turn) => sum + estimateTokens(turn.content), 0)
  } catch {
    // Ignore corrupt/missing compactor state; normal session resume still works.
  }
}
