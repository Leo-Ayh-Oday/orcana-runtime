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
}

export interface CompactOutput {
  key_insights: string[]
  discarded: string[]
  verified: string[]
  open: string[]
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

  constructor(storeDir?: string) {
    this.storeDir = storeDir ?? join(homedir(), ".orcana", "thinking")
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
            this.index.push(record as ThinkingRecord)
          }
        } catch { /* skip corrupt */ }
      }
    } catch { /* file may not exist yet */ }
  }

  private saveRecord(record: ThinkingRecord) {
    appendFileSync(join(this.storeDir, "records.jsonl"), JSON.stringify(record) + "\n", "utf-8")
    this.index.push(record)
  }

  store(query: string, reasoning: string, problemType = "debug", filePattern = "", tags: string[] = []): ThinkingRecord {
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
    this.saveRecord(record)
    return record
  }

  /** Store compressed insight (the output of compactThinkingChain). */
  storeCompressed(input: {
    query: string
    compactOutput: CompactOutput
    roundRange: string
    filePattern: string
  }): ThinkingRecord {
    const text = [
      "## Compressed Thinking Insights",
      `Rounds: ${input.roundRange}`,
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
    this.saveRecord(record)
    return record
  }

  /** Merge new compressed output into existing cold memory with lifecycle management.
   *
   *  Three-state lifecycle:
   *    - Open issues unseen for 3+ days -> degraded to discarded
   *    - Verified insights unseen for 14+ days -> degraded to insight (less emphasis)
   *    - Discarded items -> deleted after 7 days
   *    - Auto-resolve: if "open" was in last output but NOT in current output AND
   *      it was first seen >1 hour ago -> mark as resolved, move to archive
   *    - Size cap: 50 entries or 8000 tokens -> full rewrite requested
   *
   *  Returns { merged, changed } — only update L1 if changed=true. */
  mergeCompressedInsights(existingColdMemory: string, newOutput: CompactOutput): {
    merged: string
    changed: boolean
    needsFullRewrite: boolean
  } {
    const now = Date.now()
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

    // Build new insight text with per-entry lifecycle tracking
    const sections: string[] = []
    const allNewEntries: string[] = []
    if (newOutput.verified.length) {
      const entries = newOutput.verified.map(v => `- [✓] ${v} <!-- ${now} -->`)
      sections.push("## 已验证\n" + entries.join("\n"))
      allNewEntries.push(...entries)
    }
    if (newOutput.discarded.length) {
      const entries = newOutput.discarded.map(d => `- [✗] ${d} <!-- ${now} -->`)
      sections.push("## 已推翻\n" + entries.join("\n"))
      allNewEntries.push(...entries)
    }
    if (newOutput.key_insights.length) {
      const entries = newOutput.key_insights.map(k => `- [·] ${k} <!-- ${now} -->`)
      sections.push("## 关键洞察\n" + entries.join("\n"))
      allNewEntries.push(...entries)
    }
    if (newOutput.open.length) {
      const entries = newOutput.open.map(o => `- [?] ${o} <!-- ${now} -->`)
      sections.push("## 待解决\n" + entries.join("\n"))
      allNewEntries.push(...entries)
    }
    const newText = sections.join("\n\n")
    const newPhrases = extractPhrases(newText)

    if (newPhrases.size === 0) return { merged: existingColdMemory, changed: false, needsFullRewrite: false }

    // Parse numeric timestamp, return 0 for invalid
    const parseEntryTs = (raw: string): number => {
      const n = Number(raw)
      return Number.isFinite(n) && n > 0 ? n : 0
    }

    // Parse cold memory entry: extract marker, text, and optional timestamp.
    // Format: "- [{marker}] {text} <!-- {ts} -->" where marker can contain spaces.
    const parseColdEntry = (line: string): { marker: string; text: string; ts: number } | null => {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith("- [")) return null
      // Match everything between "[" and "]" as the marker (may contain spaces: "✓✓ resolved")
      const bracketMatch = trimmed.match(/^-\s*\[([^\]]+)\]/)
      if (!bracketMatch) return null
      const marker = bracketMatch[1]!.trim() || "·"
      // After "]", everything before optional "<!-- ts -->" is the entry text
      const afterBracket = trimmed.slice(bracketMatch[0]!.length).trim()
      const tsMatch = afterBracket.match(/<!--\s*(\d+)\s*-->/)
      const ts = tsMatch ? parseEntryTs(tsMatch[1]!) : 0
      const text = afterBracket.replace(/\s*<!--\s*\d+\s*-->\s*$/, "").trim().slice(0, 120)
      return { marker, text: text || afterBracket.slice(0, 120), ts }
    }

    // Auto-resolve open issues that fell off this compression
    const prevOpen = new Map<string, number>() // text -> firstSeenTime
    for (const line of existingColdMemory.split("\n")) {
      const entry = parseColdEntry(line)
      if (entry && (entry.marker === "?")) {
        prevOpen.set(entry.text, entry.ts)
      }
    }
    const newNotOpen = extractPhrases(
      newOutput.verified.join("\n") + newOutput.key_insights.join("\n")
    )
    const newlyResolved: string[] = []
    for (const [text, firstSeen] of prevOpen) {
      if (now - firstSeen > 3_600_000) { // >1 hour old
        const txtPhrases = extractPhrases(text)
        let found = false
        for (const p of txtPhrases) { if (newNotOpen.has(p)) { found = true; break } }
        let stillOpen = false
        for (const o of newOutput.open) { if (extractPhrases(o).size > 0 && overlap(extractPhrases(text), extractPhrases(o)) > 0.5) { stillOpen = true; break } }
        if (!stillOpen && !found) {
          newlyResolved.push(`- [✓✓ resolved] ${text} <!-- ${now} -->`)
        }
      }
    }

    // Time-based decay on existing entries
    const DAY_3 = 3 * 86400000
    const DAY_7 = 7 * 86400000
    const DAY_14 = 14 * 86400000
    let totalEntries = 0
    let estimatedTokens = 0
    const preserved: string[] = []

    for (const line of existingColdMemory.split("\n")) {
      const entry = parseColdEntry(line)
      if (!entry) {
        if (line.trim()) preserved.push(line)
        continue
      }

      const { marker, text, ts } = entry
      totalEntries++
      estimatedTokens += Math.ceil(text.length / 2.5)

      // Decay: only apply decay when ts > 0 (has a real timestamp)
      if (ts > 0) {
        if (marker === "?" && now - ts > DAY_3) continue
        if ((marker === "✓" || marker === "✓✓") && now - ts > DAY_14) continue
        if (marker === "✗" && now - ts > DAY_7) continue
      }

      // Already-resolved entries preserved as-is
      const resolvedMatch = text.match(/^\[✓✓\s*resolved\]\s*(.+)/)
      if (resolvedMatch) {
        preserved.push(`- [✓✓] ${resolvedMatch[1]!.trim()} <!-- ${ts || now} -->`)
        continue
      }

      preserved.push(`- [${marker}] ${text} <!-- ${ts || now} -->`)
    }

    const needsFullRewrite =
      estimatedTokens > 8000 && (totalEntries > 50 || preserved.length > 50)

    // Overlap check
    let intersection = 0
    for (const phrase of newPhrases) {
      if (existingPhrases.has(phrase)) intersection++
    }
    const overlapRatio = intersection / newPhrases.size

    if (overlapRatio > 0.8 && !needsFullRewrite) {
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
      "- 删除超过2周未再出现的旧条目",
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

  findRelevant(query: string, maxResults = 3): ThinkingRecord[] {
    const queryTokens = tokenize(query)
    if (queryTokens.size === 0) return []
    const scored = this.index.map(e => {
      const haystack = `${e.problemType} ${e.reasoning ?? ""}`.toLowerCase()
      const haystackTokens = tokenize(haystack)
      let s = tokenOverlap(queryTokens, haystackTokens) * 3
      s += Math.max(0, 1 - (Date.now() - e.timestamp) / (7 * 86400000))
      return { e, s }
    })
    return scored.filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, maxResults).map(x => x.e)
  }

  findSimilar(query: string, problemType?: string, filePattern = "", maxResults = 3): ThinkingRecord[] {
    const queryTokens = tokenize(query)
    if (queryTokens.size === 0) return []
    const scored: Array<[number, ThinkingRecord]> = []

    for (const rec of this.index) {
      if (!rec || !rec.queryPreview || !rec.problemType) continue
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

  /** Two-stage semantic search: keyword coarse-filter -> Flash batch scoring. */
  async findSimilarSemantic(
    query: string,
    semanticScorer: (query: string, candidates: ThinkingRecord[]) => Promise<number[]>,
    problemType?: string,
    filePattern?: string,
    maxResults = 5,
  ): Promise<ThinkingRecord[]> {
    const coarse = this.findSimilar(query, problemType, filePattern ?? "", 15)
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

  /** Format historical thinking chains for L3 volatile context (per-round injection). */
  formatForVolatileContext(records: ThinkingRecord[]): string {
    if (!records.length) return ""
    const chainRecords = records.filter(r => r.kind === "thinking_chain")
    if (!chainRecords.length) return ""

    const parts = ["## Historical Context（本轮相关）", ""]
    for (let i = 0; i < Math.min(chainRecords.length, 3); i++) {
      const rec = chainRecords[i]!
      const tagInfo = rec.tags?.length ? ` [${rec.tags.join(", ")}]` : ""
      parts.push(`### Round ${rec.roundNum ?? "?"}${tagInfo} — ${rec.queryPreview.slice(0, 60)}`)
      const thinkingText = rec.reasoning.length > 2000
        ? rec.reasoning.slice(0, 2000) + "\n..."
        : rec.reasoning
      parts.push(`<think>\n${thinkingText}\n</think>`)
      if (rec.toolContext?.length) {
        parts.push(`**工具:** ${rec.toolContext.join(", ")}`)
      }
      parts.push("")
    }
    return parts.join("\n")
  }

  formatForPrompt(records: ThinkingRecord[]): string {
    if (!records.length) return ""
    const parts = ["## Similar Past Reasoning\n"]
    for (let i = 0; i < records.length; i++) {
      const rec = records[i]!
      parts.push(`### Example ${i + 1}: ${rec.problemType} — ${rec.queryPreview.slice(0, 80)}`)
      const r = rec.reasoning.length > 1500 ? rec.reasoning.slice(0, 1500) + "\n..." : rec.reasoning
      parts.push(`<think>\n${r}\n</think>\n`)
    }
    return parts.join("\n")
  }

  /** Recover all compressed insight records for cross-session loading. */
  getCompressedInsights(): ThinkingRecord[] {
    return this.index.filter(r => r.kind === "compressed_insight")
  }

  /** Recover recent thinking chains for a given file pattern. */
  getRecentChains(filePattern?: string, maxResults = 10): ThinkingRecord[] {
    const chains = this.index.filter(r => r.kind === "thinking_chain")
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
