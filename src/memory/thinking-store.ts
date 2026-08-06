/** Thinking store — persist and reuse DeepSeek V4 reasoning chains.
 *  Ported from orcana/core/thinking_store.py */

import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { tokenize, tokenOverlap } from "./tokenizer"

export interface ThinkingBlock {
  thinking: string
  signature: string
}

export interface ThinkingRecord {
  id: string
  timestamp: number
  problemType: string
  queryHash: string
  queryPreview: string
  reasoning: string
  tokens: number
  filePattern: string
  tags: string[]
  /** Distinguishes original tool-result records from real thinking chains */
  kind: "tool_result" | "thinking_chain" | "compressed_insight"
  thinkingBlocks?: ThinkingBlock[]
  roundNum?: number
  toolContext?: string[]
  /** K10 (RC-18): 项目命名空间——不同项目（workspace）隔离存储，防止跨项目串线。
   *  缺省（旧记录）视为 "__global__"。 */
  namespace?: string
  /** K42 (RC-18): 写入时记录检索绑定上下文，检索时可按 binding 过滤候选，
   *  防跨 workspace/commit/model 上下文串线。 */
  workspace?: string
  commit?: string
  model?: string
}

/** K42 (RC-18): 检索绑定——候选必须匹配提供字段（未提供的字段不过滤）。
 *  写入时由 store/storeThinking/storeCompressed 记录；检索时
 *  findRelevant/findSimilar/findSimilarSemantic 等按此过滤。
 *  严格匹配：记录缺失某绑定字段时视为不匹配（防旧数据漏进新上下文）。 */
export interface ThinkingBinding {
  workspace?: string
  commit?: string
  model?: string
}

export interface CompactOutput {
  key_insights: string[]
  discarded: string[]
  verified: string[]
  open: string[]
  /** K8 (RC-18): 可选证据锚——compact output 源自哪个验证证据状态
   *  （transaction 绑定 digest + evidence ledger 摘要）。verified 结论
   *  据此可溯源，防止「被验证的结论」来自已被推翻/篡改的中间态。 */
  evidence?: string
}

/** K45 (RC-18): evidence 锚 → 8 位短 token，用于冷记忆条目级证据比较
 *  （`<!-- {ts}:e:{token} -->` 注释内）。相同锚 → 相同 token。 */
export function evidenceToken(evidence?: string): string | undefined {
  if (!evidence) return undefined
  return createHash("sha256").update(evidence).digest("hex").slice(0, 8)
}

/** K43 (RC-18): 超长内容按结构截断——保留首尾，中间省略并标注。 */
export function truncateHeadTail(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.max(40, Math.floor(max * 0.6))
  const tail = Math.max(40, max - head)
  return `${text.slice(0, head)}…[中略 ${text.length - max} 字符]…${text.slice(-tail)}`
}

/** K43 (RC-18): 单个候选的 Semantic Scorer 输入——展开为「问题 + 推理正文」，
 *  取代 80 字符预览截断（`queryPreview.slice(0, 80)` 看不到推理主体）。
 *  预算默认 1200 字符（覆盖推理主体），超长保留首尾。 */
export function scorerCandidateText(rec: ThinkingRecord, maxChars = 1200): string {
  const query = (rec.queryPreview ?? "").trim()
  const bodyBudget = Math.max(200, Math.floor(maxChars * 0.9))
  const body = truncateHeadTail(rec.reasoning ?? "", bodyBudget)
  const parts: string[] = []
  if (query) parts.push(`问题: ${query}`)
  parts.push(`推理: ${body}`)
  return parts.join("\n")
}

/** K43 (RC-18): 批量候选行（`候选N: …`），供 Semantic Scorer 提示构造——
 *  与现有调用方输出形状同构（候选N 前缀），但内容为完整/放大正文。 */
export function formatScorerCandidates(
  candidates: ThinkingRecord[],
  opts: { perCandidateChars?: number } = {},
): string {
  const maxChars = opts.perCandidateChars ?? 1200
  return candidates
    .map((c, i) => `候选${i + 1}: ${scorerCandidateText(c, maxChars)}`)
    .join("\n\n")
}

/** K44 (RC-18): 原始推理链清洗为「一句话结论 + 关键事实」——剥离 `<think>` 标记、
 *  剔除过程性叙述与猜测/错误假设措辞，供上下文注入（防止原始推理链的
 *  错误路径/假设污染后续回合）。确定性启发式实现，无 LLM 依赖；
 *  无保留句子时回退到最后一句（不吞内容）。 */
export function sanitizeReasoningForReplay(thinkingText: string): {
  conclusion: string
  facts: string[]
} {
  const text = (thinkingText ?? "").replace(/<\/?think>/gi, "").trim()
  if (!text) return { conclusion: "", facts: [] }

  const sentences = (text.match(/[^。！？.!?]+[。！？.!?]?/g) ?? [])
    .map(s => s.trim())
    .filter(Boolean)

  // 启发式剔除：过程性叙述开头 / 猜测与错误假设措辞
  // 注意：JS 的 \w/\b 只认 ASCII，CJK 不加 \b 边界（否则中文词匹配不到）。
  const PROCESS_START = /^(我需要|我要|让我|我先|接下来|首先|然后|现在|开始|尝试|试着|继续|再看|重新|不如|先|再)/u
  const WEAK = /我猜|猜测|推测|假设|也许|大概|或许|臆测|不确定|怀疑|可能|possibly|maybe|perhaps|guess|assume|hypothes|suspect/i

  const keep: string[] = []
  for (const s of sentences) {
    if (PROCESS_START.test(s)) continue
    if (WEAK.test(s)) continue
    keep.push(s)
  }
  const pool = keep.length > 0 ? keep : sentences
  const conclusion = pool[pool.length - 1] ?? ""
  const facts = pool.slice(0, Math.max(0, pool.length - 1)).slice(-3)
  return { conclusion, facts }
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const item of a) { if (b.has(item)) intersection++ }
  return intersection / Math.max(a.size, b.size)
}

export class ThinkingStore {
  private storeDir: string
  private index: ThinkingRecord[] = []
  /** K10 (RC-18): 项目命名空间——同一 store 目录内按 namespace 隔离读写，
   *  不同项目（如不同 workspace root）不得互相串线。缺省 "__global__"
   *  保持旧行为不变（旧记录无 namespace 字段，归属 __global__）。 */
  private namespace: string

  constructor(storeDir?: string, namespace = "__global__") {
    this.storeDir = storeDir ?? join(homedir(), ".orcana", "thinking")
    this.namespace = namespace
    mkdirSync(this.storeDir, { recursive: true })
    this.loadIndex()
  }

  private loadIndex() {
    this.index = []
    const path = join(this.storeDir, "records.jsonl")
    if (!existsSync(path)) { mkdirSync(this.storeDir, { recursive: true }); return }
    try {
      for (const line of readFileSync(path, "utf-8").split("\n")) {
        if (!line.trim()) continue
        try {
          const record = JSON.parse(line)
          if (record && record.queryPreview && record.problemType) {
            // K10: 仅载入本命名空间的记录；旧记录（无 namespace 字段）归属 __global__
            const ns = (record.namespace ?? "__global__") as string
            if (ns !== this.namespace) continue
            record.namespace = ns
            this.index.push(record as ThinkingRecord)
          }
        } catch { /* skip corrupt */ }
      }
    } catch { /* file may not exist yet */ }
  }

  private saveRecord(record: ThinkingRecord) {
    record.namespace = this.namespace
    appendFileSync(join(this.storeDir, "records.jsonl"), JSON.stringify(record) + "\n", "utf-8")
    this.index.push(record)
  }

  /** K42 (RC-18): 写入时把 binding（workspace/commit/model）盖到记录上。 */
  private stampBinding(record: ThinkingRecord, binding?: ThinkingBinding) {
    if (!binding) return
    if (binding.workspace !== undefined) record.workspace = binding.workspace
    if (binding.commit !== undefined) record.commit = binding.commit
    if (binding.model !== undefined) record.model = binding.model
  }

  /** K42 (RC-18): 检索绑定过滤——提供某字段时必须精确匹配；记录缺失该字段
   *  视为不匹配（严格语义，防无绑定旧数据漏进带绑定的检索）。 */
  private matchesBinding(rec: ThinkingRecord, binding?: ThinkingBinding): boolean {
    if (!binding) return true
    if (binding.workspace !== undefined && rec.workspace !== binding.workspace) return false
    if (binding.commit !== undefined && rec.commit !== binding.commit) return false
    if (binding.model !== undefined && rec.model !== binding.model) return false
    return true
  }

  store(
    query: string,
    reasoning: string,
    problemType = "debug",
    filePattern = "",
    tags: string[] = [],
    binding?: ThinkingBinding,
  ): ThinkingRecord {
    const record: ThinkingRecord = {
      id: createHash("sha256").update(query + reasoning.slice(0, 100)).digest("hex").slice(0, 12),
      timestamp: Date.now(),
      problemType,
      queryHash: createHash("sha256").update(query).digest("hex").slice(0, 16),
      queryPreview: query.slice(0, 100),
      reasoning,
      tokens: Math.ceil(reasoning.length / 3),
      filePattern,
      tags,
      kind: "tool_result",
    }
    this.stampBinding(record, binding)
    this.saveRecord(record)
    return record
  }

  /** Store actual thinking chain (not tool results). */
  storeThinking(input: {
    query: string
    thinkingBlocks: ThinkingBlock[]
    roundNum: number
    filePattern: string
    tags: string[]
    toolContext?: string[]
    /** K42 (RC-18): 可选检索绑定（workspace/commit/model）。 */
    binding?: ThinkingBinding
  }): ThinkingRecord {
    const thinkingText = input.thinkingBlocks.map(tb => tb.thinking).join("\n---\n")
    const record: ThinkingRecord = {
      id: createHash("sha256")
        .update(input.query + (input.thinkingBlocks[0]?.thinking ?? "").slice(0, 200))
        .digest("hex").slice(0, 12),
      timestamp: Date.now(),
      problemType: "reasoning",
      queryHash: createHash("sha256").update(input.query).digest("hex").slice(0, 16),
      queryPreview: input.query.slice(0, 100),
      reasoning: thinkingText.slice(0, 4000),
      tokens: Math.ceil(thinkingText.length / 3),
      filePattern: input.filePattern,
      tags: input.tags,
      kind: "thinking_chain",
      thinkingBlocks: input.thinkingBlocks.slice(0, 3),
      roundNum: input.roundNum,
      toolContext: input.toolContext,
    }
    this.stampBinding(record, input.binding)
    this.saveRecord(record)
    return record
  }

  /** Store compressed insight (the output of compactThinkingChain). */
  storeCompressed(input: {
    query: string
    compactOutput: CompactOutput
    roundRange: string
    filePattern: string
    /** K8: 可选证据锚，写入存储文本 `Evidence:` 行（向后兼容——不传也 OK）。 */
    evidence?: string
    /** K42 (RC-18): 可选检索绑定（workspace/commit/model）。 */
    binding?: ThinkingBinding
  }): ThinkingRecord {
    const evidence = input.evidence ?? input.compactOutput.evidence
    const text = [
      "## Compressed Thinking Insights",
      `Rounds: ${input.roundRange}`,
      ...(evidence ? [`Evidence: ${evidence}`] : []),
      "",
      "### Verified",
      ...input.compactOutput.verified.map(v => `- ${v}`),
      "",
      "### Discarded",
      ...input.compactOutput.discarded.map(d => `- ${d}`),
      "",
      "### Key Insights",
      ...input.compactOutput.key_insights.map(k => `- ${k}`),
      "",
      "### Open",
      ...input.compactOutput.open.map(o => `- ${o}`),
    ].join("\n")

    const record: ThinkingRecord = {
      id: createHash("sha256").update(`compressed-${input.roundRange}-${Date.now()}`).digest("hex").slice(0, 12),
      timestamp: Date.now(),
      problemType: "compressed_insight",
      queryHash: createHash("sha256").update(input.query).digest("hex").slice(0, 16),
      queryPreview: `Compressed: ${input.roundRange}`,
      reasoning: text.slice(0, 4000),
      tokens: Math.ceil(text.length / 3),
      filePattern: input.filePattern,
      tags: ["compressed", "thinking-chain"],
      kind: "compressed_insight",
      roundNum: undefined,
    }
    this.stampBinding(record, input.binding)
    this.saveRecord(record)
    return record
  }

  /** Merge new compressed output into existing cold memory with lifecycle management.
   *
   *  Two-track lifecycle (K45, RC-18):
   *    - Decay track: age only DEMOTES emphasis, never deletes —
   *      open(?) >3d -> insight(·), verified(✓) >14d -> insight(·),
   *      discarded(✗) >7d -> insight(·). Absence != resolution.
   *    - Supersede track: removal/archival only via evidence —
   *      an entry bound to an evidence token can only be overturned by a NEW
   *      entry with the SAME text carrying a DIFFERENT (newer) evidence token;
   *      evidence-bound entries are immune to time decay. Auto-resolve of open
   *      issues requires an evidence anchor on the new output (verification
   *      actively decided the issue is gone).
   *    - Size cap: 50 entries or 8000 tokens -> full rewrite requested
   *
   *  Per-entry evidence token lives in the timestamp comment as
   *  `<!-- {ts}:e:{token} -->`; legacy `<!-- {ts} -->` entries are unbound.
   *
   *  Returns { merged, changed } — only update L1 if changed=true. */
  mergeCompressedInsights(existingColdMemory: string, newOutput: CompactOutput): {
    merged: string
    changed: boolean
    needsFullRewrite: boolean
  } {
    const now = Date.now()
    const newEvToken = evidenceToken(newOutput.evidence)
    const norm = (s: string): string => s.trim().replace(/\s+/g, " ")
    const extractPhrases = (text: string): Set<string> => {
      const phrases = new Set<string>()
      const lines = text.split(/[\n.。！？;；]/).map(s => s.trim()).filter(Boolean)
      for (const line of lines) {
        const stripped = line.replace(/^[-*#>\s]+/, "").trim().slice(0, 80)
        if (stripped.length >= 6) phrases.add(stripped)
      }
      return phrases
    }

    const existingPhrases = extractPhrases(existingColdMemory)

    // Parse numeric timestamp, return 0 for invalid
    const parseEntryTs = (raw: string): number => {
      const n = Number(raw)
      return Number.isFinite(n) && n > 0 ? n : 0
    }

    // Parse cold memory entry: marker, text, optional timestamp and optional
    // K45 evidence token. Format: "- [{marker}] {text} <!-- {ts}[:e:{token}] -->"
    const parseColdEntry = (line: string): { marker: string; text: string; ts: number; ev?: string } | null => {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith("- [")) return null
      // Match everything between "[" and "]" as the marker (may contain spaces: "✓✓ resolved")
      const bracketMatch = trimmed.match(/^-\s*\[([^\]]+)\]/)
      if (!bracketMatch) return null
      const marker = bracketMatch[1]!.trim() || "·"
      // After "]", everything before optional "<!-- ts -->" is the entry text
      const afterBracket = trimmed.slice(bracketMatch[0]!.length).trim()
      const tsMatch = afterBracket.match(/<!--\s*(\d+)(?::e:([a-zA-Z0-9_-]+))?\s*-->/)
      const ts = tsMatch ? parseEntryTs(tsMatch[1]!) : 0
      const ev = tsMatch?.[2]
      const text = afterBracket
        .replace(/\s*<!--\s*\d+(?::e:[a-zA-Z0-9_-]+)?\s*-->\s*$/, "")
        .trim().slice(0, 120)
      return { marker, text: text || afterBracket.slice(0, 120), ts, ev }
    }

    const existingEntries: Array<{ line: string; marker: string; text: string; ts: number; ev?: string }> = []
    for (const line of existingColdMemory.split("\n")) {
      const entry = parseColdEntry(line)
      existingEntries.push(entry ? { line, ...entry } : { line, marker: "", text: "", ts: 0 })
    }

    // K45 supersede: same-text new entries overturn old entries iff the new
    // output carries evidence AND the old entry is unbound or bound to a
    // different token. Evidence-bound old entries win over evidence-less
    // new output (cannot be overturned without evidence).
    const supersededTexts = new Set<string>() // old entry texts dropped (overturned)
    const dedupOldTexts = new Set<string>()   // old entry kept; skip adding duplicate new entry
    const newEntryTexts = [
      ...newOutput.verified,
      ...newOutput.discarded,
      ...newOutput.key_insights,
      ...newOutput.open,
    ]
    for (const t of newEntryTexts) {
      const key = norm(t)
      const oldMatch = existingEntries.find(e => e.marker !== "" && norm(e.text) === key)
      if (!oldMatch) continue
      if (newEvToken && (!oldMatch.ev || oldMatch.ev !== newEvToken)) {
        supersededTexts.add(key) // newer evidence overturns old binding
      } else {
        dedupOldTexts.add(key)   // same/absent evidence → keep old, skip duplicate
      }
    }

    // Build new insight text with per-entry lifecycle tracking.
    // K45: 有证据锚时条目注释带 `:e:{token}`（条目级证据绑定）；同文本旧条目
    // 未被新证据推翻时去重（保留旧条目，不重复添加）。
    const entryComment = (ts: number) =>
      newEvToken ? ` <!-- ${ts}:e:${newEvToken} -->` : ` <!-- ${ts} -->`
    const sections: string[] = []
    if (newOutput.verified.length) {
      const entries = newOutput.verified.filter(v => !dedupOldTexts.has(norm(v)))
        .map(v => `- [✓] ${v}${entryComment(now)}`)
      if (entries.length) sections.push("## 已验证\n" + entries.join("\n"))
    }
    if (newOutput.discarded.length) {
      const entries = newOutput.discarded.filter(d => !dedupOldTexts.has(norm(d)))
        .map(d => `- [✗] ${d}${entryComment(now)}`)
      if (entries.length) sections.push("## 已推翻\n" + entries.join("\n"))
    }
    if (newOutput.key_insights.length) {
      const entries = newOutput.key_insights.filter(k => !dedupOldTexts.has(norm(k)))
        .map(k => `- [·] ${k}${entryComment(now)}`)
      if (entries.length) sections.push("## 关键洞察\n" + entries.join("\n"))
    }
    if (newOutput.open.length) {
      const entries = newOutput.open.filter(o => !dedupOldTexts.has(norm(o)))
        .map(o => `- [?] ${o}${entryComment(now)}`)
      if (entries.length) sections.push("## 待解决\n" + entries.join("\n"))
    }
    // K8: 证据锚随合并结果并进冷记忆——verified/insight 条目由此可溯源到
    // 采集时的验证证据状态（commit/ledger digest）。
    if (newOutput.evidence) {
      sections.unshift(`Evidence: ${newOutput.evidence}`)
    }
    const newText = sections.join("\n\n")
    const newPhrases = extractPhrases(newText)

    if (newPhrases.size === 0) return { merged: existingColdMemory, changed: false, needsFullRewrite: false }

    // K45 auto-resolve: requires an evidence anchor (absence alone never resolves)
    const prevOpen = new Map<string, number>() // text -> firstSeenTime
    for (const e of existingEntries) {
      if (e.marker === "?") prevOpen.set(e.text, e.ts)
    }
    const newNotOpen = extractPhrases(
      newOutput.verified.join("\n") + newOutput.key_insights.join("\n")
    )
    const newlyResolved: string[] = []
    const resolvedTexts = new Set<string>()
    if (newEvToken) {
      for (const [text, firstSeen] of prevOpen) {
        if (now - firstSeen > 3_600_000) { // >1 hour old
          const txtPhrases = extractPhrases(text)
          let found = false
          for (const p of txtPhrases) { if (newNotOpen.has(p)) { found = true; break } }
          let stillOpen = false
          for (const o of newOutput.open) { if (extractPhrases(o).size > 0 && overlap(extractPhrases(text), extractPhrases(o)) > 0.5) { stillOpen = true; break } }
          if (!stillOpen && !found) {
            resolvedTexts.add(norm(text))
            newlyResolved.push(`- [✓✓ resolved] ${text} <!-- ${now} -->`)
          }
        }
      }
    }

    // K45 decay track: demote-only, never delete; evidence-bound entries immune.
    const DAY_3 = 3 * 86400000
    const DAY_7 = 7 * 86400000
    const DAY_14 = 14 * 86400000
    let totalEntries = 0
    let estimatedTokens = 0
    const preserved: string[] = []

    for (const { marker, text, ts, ev } of existingEntries) {
      if (!marker) {
        if (text.trim()) preserved.push(text) // non-entry lines (section headers etc.)
        continue
      }

      totalEntries++
      estimatedTokens += Math.ceil(text.length / 2.5)

      if (supersededTexts.has(norm(text))) continue // overturned by newer evidence (K45)
      if (resolvedTexts.has(norm(text))) continue   // evidence-backed resolution (K45)

      // Already-resolved entries preserved as-is
      const resolvedMatch = text.match(/^\[✓✓\s*resolved\]\s*(.+)/)
      if (resolvedMatch) {
        preserved.push(`- [✓✓] ${resolvedMatch[1]!.trim()} <!-- ${ts || now} -->`)
        continue
      }

      // Decay: only when ts > 0 AND entry is NOT evidence-bound.
      // Demote to insight (·) instead of dropping — absence != resolution.
      if (ts > 0 && !ev) {
        if (marker === "?" && now - ts > DAY_3) { preserved.push(`- [·] ${text} <!-- ${ts} -->`); continue }
        if ((marker === "✓" || marker === "✓✓") && now - ts > DAY_14) { preserved.push(`- [·] ${text} <!-- ${ts} -->`); continue }
        if (marker === "✗" && now - ts > DAY_7) { preserved.push(`- [·] ${text} <!-- ${ts} -->`); continue }
      }

      preserved.push(`- [${marker}] ${text} <!-- ${ts || now}${ev ? `:e:${ev}` : ""} -->`)
    }

    const needsFullRewrite =
      estimatedTokens > 8000 && (totalEntries > 50 || preserved.length > 50)

    // Overlap check — supersede/resolution forces a merge regardless
    let intersection = 0
    for (const phrase of newPhrases) {
      if (existingPhrases.has(phrase)) intersection++
    }
    const overlapRatio = intersection / newPhrases.size

    if (overlapRatio > 0.8 && !needsFullRewrite && supersededTexts.size === 0 && newlyResolved.length === 0) {
      return { merged: existingColdMemory, changed: false, needsFullRewrite }
    }

    const mergedParts: string[] = []
    if (preserved.length > 0) {
      mergedParts.push(preserved.join("\n"))
    }
    if (newlyResolved.length > 0) {
      mergedParts.push("## 已解决\n" + newlyResolved.join("\n"))
    }
    mergedParts.push(newText)
    const merged = mergedParts.join("\n\n")

    return { merged, changed: true, needsFullRewrite }
  }

  /** Full cold memory rewrite — compact to <=30 entries via Flash. */
  async fullRewriteColdMemory(
    currentMemory: string,
    streamChat: (system: string, prompt: string) => AsyncGenerator<{ type: string; data?: unknown }>,
  ): Promise<string> {
    const prompt = [
      "以下是冷记忆的当前内容。请整合、去重、提纯为精简版。",
      "规则:",
      "- 合并语义重复的条目",
      "- 删除已完成/已解决的（标记 [✓✓] 或 resolved）",
      "- 超过2周未再出现的条目降级为 [·] 洞察（仅降权，不删除；",
      "  删除仅限被更新证据 supersede 推翻的条目）",
      "- 为每条剩余条目保留标记 [✓]/[?]/[✗]/[·]",
      "- 每条一行，最多50条",
      "- 保留原格式: `- [标记] 内容 <!-- timestamp -->`",
      "",
      "输出纯文本，不是JSON。不要其他文字。",
      "",
      currentMemory.slice(0, 6000),
    ].join("\n")

    try {
      const chunks: string[] = []
      for await (const ev of streamChat("你是冷记忆压缩器。输出纯文本。", prompt)) {
        if (ev.type === "text" && typeof ev.data === "string") chunks.push(ev.data)
      }
      const result = chunks.join("").trim()
      return result.length > 200 ? result : currentMemory
    } catch {
      return currentMemory
    }
  }

  findRelevant(query: string, maxResults = 3, binding?: ThinkingBinding): ThinkingRecord[] {
    const queryTokens = tokenize(query)
    if (queryTokens.size === 0) return []
    const scored = this.index
      .filter(e => this.matchesBinding(e, binding))
      .map(e => {
        const haystack = `${e.problemType} ${e.reasoning ?? ""}`.toLowerCase()
        const haystackTokens = tokenize(haystack)
        let s = tokenOverlap(queryTokens, haystackTokens) * 3
        s += Math.max(0, 1 - (Date.now() - e.timestamp) / (7 * 86400000))
        return { e, s }
      })
    return scored.filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, maxResults).map(x => x.e)
  }

  findSimilar(query: string, problemType?: string, filePattern = "", maxResults = 3, binding?: ThinkingBinding): ThinkingRecord[] {
    const queryTokens = tokenize(query)
    if (queryTokens.size === 0) return []
    const scored: Array<[number, ThinkingRecord]> = []

    for (const rec of this.index) {
      if (!rec || !rec.queryPreview || !rec.problemType) continue
      if (!this.matchesBinding(rec, binding)) continue
      let score = 0
      if (problemType && rec.problemType === problemType) score += 3
      const recTokens = tokenize(rec.queryPreview)
      score += tokenOverlap(queryTokens, recTokens) * 2
      if (filePattern && rec.filePattern) {
        for (const p of filePattern.split(",")) if (rec.filePattern.includes(p)) score += 2
      }
      const ageHours = (Date.now() - rec.timestamp) / 3600000
      score += Math.max(0, 1.0 - ageHours / 168)

      if (score > 0) scored.push([score, rec])
    }
    return scored.sort((a, b) => b[0] - a[0]).slice(0, maxResults).map(([, r]) => r)
  }

  /** Two-stage semantic search: keyword coarse-filter -> Flash batch scoring.
   *
   *  K43 (RC-18): scorer 必须基于候选完整内容评分，而不是 80 字符预览——
   *  推荐用 `formatScorerCandidates(candidates)` / `scorerCandidateText(rec)`
   *  构造 scorer 输入（正文预算 1200 字符、超长保留首尾）。 */
  async findSimilarSemantic(
    query: string,
    semanticScorer: (query: string, candidates: ThinkingRecord[]) => Promise<number[]>,
    problemType?: string,
    filePattern?: string,
    maxResults = 5,
    binding?: ThinkingBinding,
  ): Promise<ThinkingRecord[]> {
    const coarse = this.findSimilar(query, problemType, filePattern ?? "", 15, binding)
    if (coarse.length <= 3) return coarse.slice(0, maxResults)

    try {
      const scores = await semanticScorer(query, coarse)
      const scored = coarse
        .map((rec, i) => ({ rec, score: scores[i] ?? 0 }))
        .filter(x => x.score >= 6)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults)
        .map(x => x.rec)
      return scored.length ? scored : coarse.slice(0, maxResults)
    } catch {
      return coarse.slice(0, maxResults)
    }
  }

  /** Format thinking blocks for L1 cold memory (compressed insights). */
  formatForColdMemory(output: CompactOutput): string {
    const sections: string[] = []
    if (output.verified.length) {
      sections.push("## 已验证\n" + output.verified.map(v => `- ${v}`).join("\n"))
    }
    if (output.discarded.length) {
      sections.push("## 已推翻\n" + output.discarded.map(d => `- ${d}`).join("\n"))
    }
    if (output.key_insights.length) {
      sections.push("## 关键洞察\n" + output.key_insights.map(k => `- ${k}`).join("\n"))
    }
    if (output.open.length) {
      sections.push("## 待解决\n" + output.open.map(o => `- ${o}`).join("\n"))
    }
    return sections.length ? `### Compressed Insights\n\n${sections.join("\n\n")}` : ""
  }

  /** Format historical thinking chains for L3 volatile context (per-round injection).
   *
   *  K44 (RC-18): 注入前清洗——不注入原始 `<think>` 链（防止原始推理的
   *  错误路径/假设污染后续回合），转换为「一句话结论 + 关键事实」，
   *  并附来源标注（来自 round N 推理）。段标题格式保持不变。 */
  formatForVolatileContext(records: ThinkingRecord[]): string {
    if (!records.length) return ""
    const chainRecords = records.filter(r => r.kind === "thinking_chain")
    if (!chainRecords.length) return ""

    const parts = ["## Historical Context（本轮相关）", ""]
    for (let i = 0; i < Math.min(chainRecords.length, 3); i++) {
      const rec = chainRecords[i]!
      const tagInfo = rec.tags?.length ? ` [${rec.tags.join(", ")}]` : ""
      const { conclusion, facts } = sanitizeReasoningForReplay(rec.reasoning)
      if (!conclusion && facts.length === 0) continue
      parts.push(`### Round ${rec.roundNum ?? "?"}${tagInfo} — ${rec.queryPreview.slice(0, 60)}（来自 round ${rec.roundNum ?? "?"} 推理）`)
      if (conclusion) parts.push(`结论: ${conclusion}`)
      if (facts.length) {
        parts.push("关键事实:")
        for (const f of facts.slice(0, 3)) parts.push(`- ${f}`)
      }
      if (rec.toolContext?.length) {
        parts.push(`**工具:** ${rec.toolContext.join(", ")}`)
      }
      parts.push("")
    }
    if (parts.length === 2) return ""
    return parts.join("\n")
  }

  /** K44 (RC-18): 与 formatForVolatileContext 同款清洗——无 `<think>` 标记，
   *  仅一句话结论 + 关键事实。段标题格式（## Similar Past Reasoning /
   *  ### Example N）保持不变。 */
  formatForPrompt(records: ThinkingRecord[]): string {
    if (!records.length) return ""
    const parts = ["## Similar Past Reasoning\n"]
    for (let i = 0; i < records.length; i++) {
      const rec = records[i]!
      const { conclusion, facts } = sanitizeReasoningForReplay(rec.reasoning)
      if (!conclusion && facts.length === 0) continue
      parts.push(`### Example ${i + 1}: ${rec.problemType} — ${rec.queryPreview.slice(0, 80)}`)
      if (conclusion) parts.push(`结论: ${conclusion}`)
      if (facts.length) parts.push(`关键事实:\n${facts.slice(0, 3).map(f => `- ${f}`).join("\n")}`)
      parts.push("")
    }
    return parts.join("\n")
  }

  /** Recover all compressed insight records for cross-session loading. */
  getCompressedInsights(binding?: ThinkingBinding): ThinkingRecord[] {
    return this.index.filter(r => r.kind === "compressed_insight" && this.matchesBinding(r, binding))
  }

  /** Recover recent thinking chains for a given file pattern. */
  getRecentChains(filePattern?: string, maxResults = 10, binding?: ThinkingBinding): ThinkingRecord[] {
    const chains = this.index.filter(r => r.kind === "thinking_chain" && this.matchesBinding(r, binding))
    if (filePattern) {
      return chains
        .filter(r => filePattern.split(",").some(p => r.filePattern.includes(p)))
        .slice(-maxResults)
    }
    return chains.slice(-maxResults)
  }

  stats() {
    const byType: Record<string, number> = {}
    for (const r of this.index) {
      const key = r.kind ?? r.problemType
      byType[key] = (byType[key] ?? 0) + 1
    }
    return { totalRecords: this.index.length, byType }
  }
}
