/** Knowledge base — stores learned solutions across sessions.
 *
 *  Format: JSONL, one entry per learned insight.
 *  Stored in ~/.orcana/knowledge/
 *
 *  V2: supports research distillation — web_search/web_fetch results are
 *  extracted by Flash into structured KeyFact[], then stored here with
 *  source URLs and expiration metadata. Old entries (30d unused) auto-pruned
 *  on load. Active entries are candidates for L1 cold memory injection.
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, renameSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { SqliteStore } from "./sqlite-store"
import { tokenize, tokenOverlap, isCJK } from "./tokenizer"

export interface KnowledgeEntry {
  id: string
  timestamp: number
  topic: string        // e.g. "windows shell", "FIM API", "deepseek thinking mode"
  problem: string      // what went wrong or what was researched
  solution: string     // what was learned (key fact, answer, fix)
  source: "self-discovered" | "web_search" | "web_fetch" | string  // where the knowledge came from
  sourceURL?: string   // URL if sourced from web
  extractedAt?: number // when the fact was extracted from source (may differ from timestamp)
  expires?: number     // optional expiration timestamp (30d default from source)
  confidence?: number  // 0-1 how certain this knowledge is
}

export interface KeyFact {
  topic: string
  fact: string
  sourceURL?: string
  confidence?: number
}

export class KnowledgeBase {
  private storeDir: string
  private index: KnowledgeEntry[] = []
  private fts: SqliteStore

  constructor(storeDir?: string) {
    this.storeDir = storeDir ?? join(homedir(), ".orcana", "knowledge")
    mkdirSync(this.storeDir, { recursive: true })
    this.fts = new SqliteStore("knowledge", this.storeDir)
    this.load()
  }

  // ── Tokenization for dedup — handles CJK (character n-gram) and Latin (word split) ──

  /** Check if text is primarily CJK (Chinese/Japanese/Korean) — no spaces between words. */
  private static isCJK(text: string): boolean {
    const cjkCount = (text.match(/[一-鿿㐀-䶿豈-﫿぀-ゟ゠-ヿ가-힯]/g) ?? []).length
    return cjkCount > text.length * 0.25
  }

  /** Tokenize text for fuzzy dedup. CJK → character bigrams+trigrams; Latin → word split. */
  private static tokenize(text: string): Set<string> {
    const tokens = new Set<string>()
    const clean = text.toLowerCase().trim()
    if (!clean) return tokens

    if (KnowledgeBase.isCJK(clean)) {
      // Character n-grams: bigrams + trigrams catch 80%+ semantic overlap
      for (let i = 0; i < clean.length - 1; i++) {
        tokens.add(clean.slice(i, i + 2))
      }
      for (let i = 0; i < clean.length - 2; i++) {
        tokens.add(clean.slice(i, i + 3))
      }
      // Also keep individual CJK chars as fallback
      for (const ch of clean) {
        if (/[一-鿿]/.test(ch)) tokens.add(ch)
      }
    } else {
      // Latin text: standard word split
      for (const w of clean.split(/[\s,.;:!?()\[\]{}'"\/\\\-–—|@#$%^&*+=<>]+/)) {
        if (w.length >= 3) tokens.add(w)
      }
    }
    return tokens
  }

  /** Jaccard similarity between two token sets. */
  private static tokenOverlap(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0
    let intersection = 0
    for (const t of a) { if (b.has(t)) intersection++ }
    return intersection / Math.max(a.size, b.size)
  }

  private load() {
    this.index = []
    const path = join(this.storeDir, "entries.jsonl")
    if (!existsSync(path)) return
    try {
      const entries: KnowledgeEntry[] = []
      for (const line of readFileSync(path, "utf-8").split("\n")) {
        if (!line.trim()) continue
        try {
          const e = JSON.parse(line) as KnowledgeEntry
          if (e?.id && e?.topic) entries.push(e)
        } catch { /* skip corrupt */ }
      }
      // Prune expired entries on load (30-day default)
      const now = Date.now()
      const THIRTY_DAYS = 30 * 86400000
      this.index = entries.filter(e => {
        if (e.expires && now > e.expires) return false
        if (!e.expires && (now - e.timestamp) > THIRTY_DAYS) return false
        return true
      })
      // Rebuild FTS5 index from loaded entries so existing knowledge is searchable
      if (this.index.length > 0) {
        this.fts.rebuildFromJsonl(this.index.map(e => ({
          id: e.id, topic: e.topic, rule: e.solution, source: e.source,
        })))
      }
      // If pruning changed the list, rewrite the file
      if (this.index.length < entries.length) {
        this.rewrite()
      }
    } catch { /* corrupt, skip */ }
  }

  private rewrite() {
    const path = join(this.storeDir, "entries.jsonl")
    const content = this.index.map(e => JSON.stringify(e)).join("\n") + "\n"
    try {
      const temp = join(this.storeDir, "entries.jsonl.tmp")
      writeFileSync(temp, content, "utf-8")
      renameSync(temp, path)
    } catch {
      // rewrite is best-effort; append fallback keeps working
    }
  }

  store(topic: string, problem: string, solution: string, source = "self-discovered", sourceURL?: string): KnowledgeEntry {
    const e: KnowledgeEntry = {
      id: createHash("sha256").update(topic + problem).digest("hex").slice(0, 12),
      timestamp: Date.now(),
      topic,
      problem,
      solution,
      source,
      sourceURL,
      extractedAt: sourceURL ? Date.now() : undefined,
      expires: sourceURL ? Date.now() + 30 * 86400000 : undefined, // web-sourced facts expire in 30d
      confidence: source === "self-discovered" ? 0.5 : sourceURL ? 0.7 : 0.6,
    }
    appendFileSync(join(this.storeDir, "entries.jsonl"), JSON.stringify(e) + "\n", "utf-8")
    this.index.push(e)
    // Index into FTS5
    this.fts.index({ id: e.id, topic: e.topic, rule: e.solution, source: e.source, content: `${e.topic} ${e.problem} ${e.solution}`, timestamp: e.timestamp, confidence: e.confidence ?? 0.5 })
    return e
  }

  /** Store multiple research facts from a distillation pass. */
  storeFacts(facts: KeyFact[], source = "web_search", sourceURL?: string): KnowledgeEntry[] {
    const entries: KnowledgeEntry[] = []
    for (const f of facts.slice(0, 8)) {
      // Fuzzy dedup: CJK → character n-gram Jaccard ≥0.65; Latin → word overlap ≥0.6
      const newTokens = KnowledgeBase.tokenize(f.topic + " " + f.fact)
      const existing = this.index.find(e => {
        const existingTokens = KnowledgeBase.tokenize(e.topic + " " + e.solution)
        return KnowledgeBase.tokenOverlap(newTokens, existingTokens) >= 0.6
      })
      if (existing) {
        existing.timestamp = Date.now()
        existing.confidence = Math.min(1, (existing.confidence ?? 0.5) + 0.05)
        entries.push(existing)
        continue
      }
      const e: KnowledgeEntry = {
        id: createHash("sha256").update(f.topic + f.fact).digest("hex").slice(0, 12),
        timestamp: Date.now(),
        topic: f.topic,
        problem: f.topic,
        solution: f.fact,
        source,
        sourceURL: f.sourceURL ?? sourceURL,
        extractedAt: Date.now(),
        expires: Date.now() + 30 * 86400000,
        confidence: f.confidence ?? 0.7,
      }
      appendFileSync(join(this.storeDir, "entries.jsonl"), JSON.stringify(e) + "\n", "utf-8")
      this.index.push(e)
      // Index into FTS5
      this.fts.index({ id: e.id, topic: e.topic, rule: e.solution, source: e.source, content: `${e.topic} ${e.problem} ${e.solution}`, timestamp: e.timestamp, confidence: e.confidence ?? 0.6 })
      entries.push(e)
    }
    return entries
  }

  findRelevant(query: string, maxResults = 3): KnowledgeEntry[] {
    // Try FTS5 first for BM25-ranked search
    if (this.fts.count > 0) {
      const hits = this.fts.search(query, maxResults)
      if (hits.length > 0) {
        return hits.map(h => {
          const entry = this.index.find(e => e.id === h.id)
          return entry ?? {
            id: h.id,
            timestamp: h.timestamp,
            topic: h.topic,
            problem: h.topic,
            solution: h.rule,
            source: h.source,
            confidence: h.confidence,
          }
        })
      }
    }

    // Fallback: token-overlap search with recency/confidence bonuses
    const queryTokens = tokenize(query)
    if (queryTokens.size === 0) return []
    const scored = this.index.map(e => {
      const haystack = `${e.topic} ${e.problem} ${e.solution}`
      const entryTokens = tokenize(haystack)
      let s = tokenOverlap(queryTokens, entryTokens) * 3
      s += Math.max(0, 1 - (Date.now() - e.timestamp) / (7 * 86400000))
      s += (e.confidence ?? 0.5) * 0.5
      return { e, s }
    })
    return scored.filter(x => x.s > 0.3).sort((a, b) => b.s - a.s).slice(0, maxResults).map(x => x.e)
  }

  /** Get active (non-expired) entries for L1 cold memory injection. */
  getActive(maxResults = 10): KnowledgeEntry[] {
    const now = Date.now()
    return this.index
      .filter(e => !e.expires || now < e.expires)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, maxResults)
  }

  /** Check if we already have knowledge from a specific URL. */
  findByURL(url: string): KnowledgeEntry | undefined {
    return this.index.find(e => e.sourceURL === url)
  }

  /** Build cold memory context from active knowledge entries. */
  buildContext(query: string): string {
    const hits = this.findRelevant(query)
    if (!hits.length) return ""
    return hits.map(e =>
      `## 已学知识: ${e.topic}${e.sourceURL ? ` [来源](${e.sourceURL})` : ""}\n${e.solution}`
    ).join("\n\n")
  }

  /** Periodic reconcile: prune expired, rebuild FTS5, rewrite if changed. Call every ~50 rounds or on session save. */
  reconcile(): { pruned: number; indexed: number } {
    const before = this.index.length
    const now = Date.now()
    const THIRTY_DAYS = 30 * 86400000
    this.index = this.index.filter(e => {
      if (e.expires && now > e.expires) return false
      if (!e.expires && (now - e.timestamp) > THIRTY_DAYS) return false
      return true
    })
    const pruned = before - this.index.length
    if (pruned > 0) this.rewrite()
    // Rebuild FTS5 from current index
    if (this.index.length > 0) {
      this.fts.rebuildFromJsonl(this.index.map(e => ({
        id: e.id, topic: e.topic, rule: e.solution, source: e.source,
      })))
    }
    return { pruned, indexed: this.index.length }
  }

  stats() {
    const tips = new Set(this.index.map(e => e.topic))
    const withSource = this.index.filter(e => e.sourceURL).length
    return { entries: this.index.length, topics: tips.size, withSource }
  }

  close(): void {
    this.fts.close()
  }
}
