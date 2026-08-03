import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"
import type { RippleMemoryHit } from "../ripple/types"
import { SqliteStore, type FtsEntry } from "./sqlite-store"
import { tokenize, tokenOverlap } from "./tokenizer"

export interface HybridMemoryEntry {
  id: string
  timestamp: number
  scope: "project" | "global"
  topic: string
  rule: string
  source: string
  confidence: number
  expiresAt?: number
}

export class HybridMemory {
  private entries: HybridMemoryEntry[] = []
  private file: string
  private fts: SqliteStore

  constructor(private projectRoot = process.cwd()) {
    const dir = join(projectRoot, ".orcana")
    this.file = join(dir, "hybrid-memory.jsonl")
    mkdirSync(dir, { recursive: true })
    this.fts = new SqliteStore("hybrid-memory", dir)
    this.load()
  }

  private load() {
    this.entries = []
    if (!existsSync(this.file)) return
    try {
      for (const line of readFileSync(this.file, "utf-8").split("\n")) {
        if (!line.trim()) continue
        const entry = JSON.parse(line) as HybridMemoryEntry
        if (!entry.id || !entry.rule) continue
        if (entry.expiresAt && entry.expiresAt < Date.now()) continue
        this.entries.push(entry)
      }
      // Rebuild FTS5 index from loaded entries so existing knowledge is searchable
      if (this.entries.length > 0) {
        this.fts.rebuildFromJsonl(this.entries.map(e => ({
          id: e.id, topic: e.topic, rule: e.rule, source: e.source,
        })))
      }
    } catch {
      this.entries = []
    }
  }

  store(topic: string, rule: string, source = "self-discovered", confidence = 0.7): HybridMemoryEntry {
    const id = createHash("sha256").update(topic + rule + source).digest("hex").slice(0, 12)
    const entry: HybridMemoryEntry = {
      id,
      timestamp: Date.now(),
      scope: "project",
      topic,
      rule,
      source,
      confidence,
    }
    appendFileSync(this.file, JSON.stringify(entry) + "\n", "utf-8")
    this.entries.push(entry)
    // Index into FTS5 for fast retrieval
    this.fts.index({
      id, topic, rule, source,
      content: `${topic} ${rule} ${source}`,
      timestamp: entry.timestamp,
      confidence,
    })
    return entry
  }

  findRelevant(query: string, maxResults = 5): RippleMemoryHit[] {
    // Try FTS5 first for fast BM25-ranked search
    if (this.fts.count > 0) {
      const hits = this.fts.search(query, maxResults)
      if (hits.length > 0) {
        return hits.map(h => ({
          id: h.id,
          scope: "project" as const,
          topic: h.topic,
          rule: h.rule,
          source: h.source,
          confidence: 0.7,
        }))
      }
    }

    // Fallback: token-overlap scan with confidence bonus
    const queryTokens = tokenize(query)
    if (queryTokens.size === 0) return []
    return this.entries
      .map(entry => {
        const haystack = `${entry.topic} ${entry.rule} ${entry.source}`
        const entryTokens = tokenize(haystack)
        const score = tokenOverlap(queryTokens, entryTokens) * 3 + entry.confidence
        return { entry, score }
      })
      .filter(x => x.score > 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map(({ entry }) => ({
        id: entry.id,
        scope: entry.scope,
        topic: entry.topic,
        rule: entry.rule,
        source: entry.source,
        confidence: entry.confidence,
      }))
  }
}
