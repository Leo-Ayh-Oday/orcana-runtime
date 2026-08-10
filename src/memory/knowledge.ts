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
  /** K46: project/workspace namespace. Undefined = global knowledge, visible to every scope. */
  scope?: string
  /** K47: id of the entry that superseded this one (conflict loser). Such entries live in history.jsonl, never injected. */
  supersededBy?: string
  /** K47: when this entry was superseded. */
  supersededAt?: number
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
  /** K47: superseded (conflict-losing) entries — audit history, persisted in history.jsonl, never injected. */
  private history: KnowledgeEntry[] = []
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

  // ── K46: scope isolation — undefined scope = global knowledge (visible everywhere) ──

  /** Same scope bucket? Only same-bucket entries are dedup/conflict candidates (scope ≠ no cross-scope conflict). */
  private static sameScope(a: string | undefined, b: string | undefined): boolean {
    return (a ?? null) === (b ?? null)
  }

  /** Query-side scope filter. No query scope → full store (backward compat). Global (scope-less) entries are visible to every scope. */
  private static inScope(entryScope: string | undefined, queryScope: string | undefined): boolean {
    if (queryScope === undefined || queryScope === "") return true
    if (entryScope === undefined || entryScope === "") return true
    return entryScope === queryScope
  }

  // ── K47: conflict detection heuristics ──

  /** Negation-flip signal: one assertion affirms, the other denies → mutually exclusive. */
  private static isNegation(text: string): boolean {
    const t = text.toLowerCase()
    if (/(\bnot\b|cannot|can'?t|won'?t|doesn'?t|isn'?t|never|unable|without|denied|rejected|unsupported|incompatible|absent|\bno\b)/.test(t)) return true
    if (/(不能|无法|不可以|不支持|不会|不要|禁止|无效|失败|拒绝|不存在|没有)/.test(t)) return true
    return false
  }

  /**
   * Numeric values asserted in text (prices, sizes, counts…). Only meaningful numbers count:
   * unit-suffixed (1M/128K/50%), decimals ($0.435), or ≥3-digit counts. Disjoint numbers on
   * the same topic = contradictory answers.
   */
  private static numbersOf(text: string): string[] {
    const out: string[] = []
    for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(%|[kmbt])?/gi)) {
      const num = m[1] ?? ""
      const unit = m[2] ?? ""
      const digits = num.replace(".", "")
      if (unit || num.includes(".") || digits.length >= 3) out.push((num + unit).toLowerCase())
    }
    return out
  }

  /**
   * Conclusion tokens that remain after removing shared topic words (e.g. "…works" vs "…broken").
   * Returns overlap of the remainders; near-zero overlap with a shared topic = opposite assertions.
   */
  private static remainderOverlap(a: KnowledgeEntry, b: KnowledgeEntry): number {
    const topicTokens = new Set([...KnowledgeBase.tokenize(a.topic), ...KnowledgeBase.tokenize(b.topic)])
    const aRemainder = [...KnowledgeBase.tokenize(a.solution)].filter(t => !topicTokens.has(t))
    const bRemainder = [...KnowledgeBase.tokenize(b.solution)].filter(t => !topicTokens.has(t))
    if (aRemainder.length === 0 || bRemainder.length === 0) return 1 // can't tell → treat as non-conflicting
    return KnowledgeBase.tokenOverlap(new Set(aRemainder), new Set(bRemainder))
  }

  /** Do two same-topic solutions contradict? Negation flip, disjoint numeric answers, or near-disjoint conclusions. */
  private static isContradictory(a: KnowledgeEntry, b: KnowledgeEntry): boolean {
    const aNums = KnowledgeBase.numbersOf(a.solution)
    const bNums = KnowledgeBase.numbersOf(b.solution)
    const numsDiffer = aNums.length > 0 && bNums.length > 0 && !aNums.some(n => bNums.includes(n))
    const negFlip = KnowledgeBase.isNegation(a.solution) !== KnowledgeBase.isNegation(b.solution)
    if (negFlip || numsDiffer) return true
    if (KnowledgeBase.remainderOverlap(a, b) < 0.2) return true // same topic, opposite assertion cores
    return KnowledgeBase.tokenOverlap(KnowledgeBase.tokenize(a.solution), KnowledgeBase.tokenize(b.solution)) < 0.4
  }

  /**
   * Injection guard for pairs that escaped write-time resolution (e.g. created via store() or
   * legacy data): same topic within a scope, mutually exclusive assertions or disjoint answers.
   * Only fires on strong signals — complementary knowledge on a shared topic is never dropped.
   */
  private static isGuardConflict(a: KnowledgeEntry, b: KnowledgeEntry): boolean {
    if (!KnowledgeBase.sameScope(a.scope, b.scope)) return false
    if (KnowledgeBase.tokenOverlap(KnowledgeBase.tokenize(a.topic), KnowledgeBase.tokenize(b.topic)) < 0.6) return false
    const aNums = KnowledgeBase.numbersOf(a.solution)
    const bNums = KnowledgeBase.numbersOf(b.solution)
    const numsDiffer = aNums.length > 0 && bNums.length > 0 && !aNums.some(n => bNums.includes(n))
    const negFlip = KnowledgeBase.isNegation(a.solution) !== KnowledgeBase.isNegation(b.solution)
    if (negFlip || numsDiffer) return true
    return KnowledgeBase.remainderOverlap(a, b) < 0.2
  }

  /**
   * Winner among a contradictory pair: evidence-anchored (sourceURL, per K8) > newer > higher confidence > incoming.
   * The loser is marked supersededBy and moved to history (auditable), never deleted.
   */
  private static pickWinner(a: KnowledgeEntry, b: KnowledgeEntry): KnowledgeEntry {
    const aEv = a.sourceURL ? 1 : 0
    const bEv = b.sourceURL ? 1 : 0
    if (aEv !== bEv) return aEv > bEv ? a : b
    if (a.timestamp !== b.timestamp) return a.timestamp > b.timestamp ? a : b
    const aC = a.confidence ?? 0
    const bC = b.confidence ?? 0
    if (aC !== bC) return aC > bC ? a : b
    return b // full tie → incoming wins
  }

  /**
   * Injection guard: never hand out parallel contradictory conclusions for the same topic
   * within a scope. Entries are pre-sorted by relevance, so the higher-scored one survives.
   */
  private static dedupeContradictions(entries: KnowledgeEntry[]): KnowledgeEntry[] {
    const kept: KnowledgeEntry[] = []
    for (const e of entries) {
      const conflicts = kept.find(k => KnowledgeBase.isGuardConflict(k, e))
      if (!conflicts) kept.push(e)
    }
    return kept
  }

  private load() {
    this.index = []
    this.loadHistory()
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
      const active: KnowledgeEntry[] = []
      for (const e of entries) {
        // K47: superseded lines that survived in the file (crash window before rewrite) belong to history, never active
        if (e.supersededBy) {
          this.history.push(e)
          continue
        }
        if (e.expires && now > e.expires) continue
        if (!e.expires && (now - e.timestamp) > THIRTY_DAYS) continue
        active.push(e)
      }
      this.index = active
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

  /** K47: load the superseded audit trail (history.jsonl). Only explicit expires prune history; audit entries persist. */
  private loadHistory() {
    this.history = []
    const histPath = join(this.storeDir, "history.jsonl")
    if (!existsSync(histPath)) return
    try {
      const now = Date.now()
      for (const line of readFileSync(histPath, "utf-8").split("\n")) {
        if (!line.trim()) continue
        try {
          const e = JSON.parse(line) as KnowledgeEntry
          if (!e?.id || !e?.topic || !e.supersededBy) continue
          if (e.expires && now > e.expires) continue // only explicit expiry retires audit entries
          this.history.push(e)
        } catch { /* skip corrupt */ }
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
    // K47: keep the audit trail file in sync
    try {
      const histPath = join(this.storeDir, "history.jsonl")
      const histTemp = join(this.storeDir, "history.jsonl.tmp")
      writeFileSync(histTemp, this.history.map(e => JSON.stringify(e)).join("\n") + "\n", "utf-8")
      renameSync(histTemp, histPath)
    } catch {
      // best-effort
    }
  }

  /** K47: mark the conflict loser as superseded and move it to the auditable history (not deleted). */
  private supersede(loser: KnowledgeEntry, winnerId: string) {
    loser.supersededBy = winnerId
    loser.supersededAt = Date.now()
    this.index = this.index.filter(e => e.id !== loser.id)
    this.history.push(loser)
    try {
      appendFileSync(join(this.storeDir, "history.jsonl"), JSON.stringify(loser) + "\n", "utf-8")
    } catch { /* best-effort */ }
    this.rewrite() // drop the loser line from entries.jsonl so reloads don't resurrect it
  }

  store(topic: string, problem: string, solution: string, source = "self-discovered", sourceURL?: string, scope?: string): KnowledgeEntry {
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
      scope,
    }
    appendFileSync(join(this.storeDir, "entries.jsonl"), JSON.stringify(e) + "\n", "utf-8")
    this.index.push(e)
    // Index into FTS5
    this.fts.index({ id: e.id, topic: e.topic, rule: e.solution, source: e.source, content: `${e.topic} ${e.problem} ${e.solution}`, timestamp: e.timestamp, confidence: e.confidence ?? 0.5 })
    return e
  }

  /** Store multiple research facts from a distillation pass. Scope-scoped; conflicts resolved within a scope. */
  storeFacts(facts: KeyFact[], source = "web_search", sourceURL?: string, scope?: string): KnowledgeEntry[] {
    const entries: KnowledgeEntry[] = []
    for (const f of facts.slice(0, 8)) {
      // Fuzzy dedup: CJK → character n-gram Jaccard ≥0.65; Latin → word overlap ≥0.6 (same scope only, K46)
      const newTokens = KnowledgeBase.tokenize(f.topic + " " + f.fact)
      const existing = this.index.find(e =>
        KnowledgeBase.sameScope(e.scope, scope) &&
        KnowledgeBase.tokenOverlap(newTokens, KnowledgeBase.tokenize(e.topic + " " + e.solution)) >= 0.6
      )
      if (existing) {
        const candidate = this.buildEntry(f, source, sourceURL, scope)
        if (!KnowledgeBase.isContradictory(existing, candidate)) {
          // K47: consistent update on the same topic → normal in-place replacement
          existing.solution = f.fact
          existing.timestamp = Date.now()
          existing.confidence = Math.min(1, (existing.confidence ?? 0.5) + 0.05)
          if (f.sourceURL) existing.sourceURL = f.sourceURL
          entries.push(existing)
          continue
        }
        // K47: contradiction (mutually exclusive assertions / same topic, different conclusion).
        // Keep the evidence-anchored or newer side; the loser goes to auditable superseded history, never injected.
        const winner = KnowledgeBase.pickWinner(existing, candidate)
        const loser = winner === existing ? candidate : existing
        this.supersede(loser, winner.id)
        if (winner === candidate) {
          this.persist(candidate)
          entries.push(candidate)
        } else {
          entries.push(existing)
        }
        continue
      }
      const e = this.buildEntry(f, source, sourceURL, scope)
      this.persist(e)
      entries.push(e)
    }
    return entries
  }

  /** Build a fresh entry for a distilled fact. */
  private buildEntry(f: KeyFact, source: string, sourceURL: string | undefined, scope?: string): KnowledgeEntry {
    return {
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
      scope,
    }
  }

  /** Append a new active entry to the index, JSONL file, and FTS5. */
  private persist(e: KnowledgeEntry) {
    appendFileSync(join(this.storeDir, "entries.jsonl"), JSON.stringify(e) + "\n", "utf-8")
    this.index.push(e)
    this.fts.index({ id: e.id, topic: e.topic, rule: e.solution, source: e.source, content: `${e.topic} ${e.problem} ${e.solution}`, timestamp: e.timestamp, confidence: e.confidence ?? 0.6 })
  }

  /**
   * K46: optional scope filters to the given project/workspace namespace; unscoped queries see the full store.
   * K47: only surviving (active) facts are returned; contradictory pairs never both injected.
   */
  findRelevant(query: string, maxResults = 3, scope?: string): KnowledgeEntry[] {
    // Try FTS5 first for BM25-ranked search
    if (this.fts.count > 0) {
      const hits = this.fts.search(query, maxResults)
      const found: KnowledgeEntry[] = []
      for (const h of hits) {
        // Drop stale FTS hits (superseded/pruned) — only surviving facts are injected (K47)
        const entry = this.index.find(e => e.id === h.id)
        if (!entry) continue
        if (!KnowledgeBase.inScope(entry.scope, scope)) continue
        found.push(entry)
      }
      if (found.length > 0) {
        return KnowledgeBase.dedupeContradictions(found)
      }
    }

    // Fallback: token-overlap search with recency/confidence bonuses
    const queryTokens = tokenize(query)
    if (queryTokens.size === 0) return []
    const scored = this.index
      .filter(e => KnowledgeBase.inScope(e.scope, scope))
      .map(e => {
        const haystack = `${e.topic} ${e.problem} ${e.solution}`
        const entryTokens = tokenize(haystack)
        let s = tokenOverlap(queryTokens, entryTokens) * 3
        s += Math.max(0, 1 - (Date.now() - e.timestamp) / (7 * 86400000))
        s += (e.confidence ?? 0.5) * 0.5
        return { e, s }
      })
    return KnowledgeBase.dedupeContradictions(
      scored.filter(x => x.s > 0.3).sort((a, b) => b.s - a.s).slice(0, maxResults).map(x => x.e))
  }

  /** Get active (non-expired) entries for L1 cold memory injection. Optional scope filter (K46). */
  getActive(maxResults = 10, scope?: string): KnowledgeEntry[] {
    const now = Date.now()
    return this.index
      .filter(e => (!e.expires || now < e.expires) && KnowledgeBase.inScope(e.scope, scope))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, maxResults)
  }

  /** Check if we already have knowledge from a specific URL. Optional scope filter (K46). */
  findByURL(url: string, scope?: string): KnowledgeEntry | undefined {
    return this.index.find(e => e.sourceURL === url && KnowledgeBase.inScope(e.scope, scope))
  }

  /** Build cold memory context from active knowledge entries. Scope-scoped; scoped entries are annotated. */
  buildContext(query: string, scope?: string): string {
    const hits = this.findRelevant(query, 3, scope)
    if (!hits.length) return ""
    return hits.map(e =>
      `## 已学知识: ${e.topic}${e.scope ? `（scope: ${e.scope}）` : ""}${e.sourceURL ? ` [来源](${e.sourceURL})` : ""}\n${e.solution}`
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
    // K47: audit history is only retired by explicit expiry
    const histBefore = this.history.length
    this.history = this.history.filter(e => !(e.expires && now > e.expires))
    const histPruned = histBefore - this.history.length
    if (pruned > 0 || histPruned > 0) this.rewrite()
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
    return { entries: this.index.length, topics: tips.size, withSource, superseded: this.history.length }
  }

  close(): void {
    this.fts.close()
  }
}
