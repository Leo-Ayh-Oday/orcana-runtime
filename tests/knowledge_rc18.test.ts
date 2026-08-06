/**
 * RC-18 K46 / K47 — KnowledgeBase scope isolation & conflict resolution.
 *
 * K46 KNOWLEDGE_NAMESPACED: knowledge is global with no project namespace.
 *   → storeFacts/store/query methods accept an optional `scope`; scoped queries
 *     only see their scope + global (scope-less) entries; unscoped queries see
 *     the full store (backward compatible).
 *
 * K47 KNOWLEDGE_CONFLICT_RESOLVED: contradictory facts can coexist and both be injected.
 *   → same-scope overlapping topics are checked for contradiction (negation flip,
 *     disjoint numeric answers, near-disjoint conclusions). The evidence-anchored or
 *     newer side wins; the loser is marked supersededBy and moved to history.jsonl
 *     (auditable, never injected). Consistent updates replace in place.
 *
 * Offline & deterministic — temp dirs, no API calls.
 */
import { KnowledgeBase } from "../src/memory/knowledge"
import type { KeyFact } from "../src/memory/knowledge"
import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

let dir: string
let kb: KnowledgeBase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orcana-kb-rc18-"))
  kb = new KnowledgeBase(dir)
})

afterEach(() => {
  kb.close()
  rmSync(dir, { recursive: true, force: true })
})

function historyEntries(d: string): Array<Record<string, unknown>> {
  const p = join(d, "history.jsonl")
  if (!existsSync(p)) return []
  return readFileSync(p, "utf-8").split("\n").filter(Boolean).map(l => JSON.parse(l))
}

// ── K46: scope isolation ──

test("K46: scoped facts never leak across scopes; unscoped query sees the full store", () => {
  kb.storeFacts([{ topic: "windows shell FIM", fact: "FIM works on windows shell" }], "web_search", "http://a/1", "proj-A")
  kb.storeFacts([{ topic: "windows shell FIM", fact: "FIM broken on windows shell" }], "web_search", "http://b/1", "proj-B")

  const a = kb.findRelevant("windows shell FIM", 5, "proj-A")
  expect(a.length).toBe(1)
  expect(a[0]!.solution).toContain("works")
  expect(a[0]!.scope).toBe("proj-A")

  const b = kb.findRelevant("windows shell FIM", 5, "proj-B")
  expect(b.length).toBe(1)
  expect(b[0]!.solution).toContain("broken")
  expect(b[0]!.scope).toBe("proj-B")

  // Backward compat: no scope → 全量 (everything)
  const all = kb.findRelevant("windows shell FIM", 5)
  expect(all.length).toBe(2)
  expect(kb.stats().entries).toBe(2)
})

test("K46: global (scope-less) knowledge remains visible to scoped queries", () => {
  kb.store("npm cache", "npm cache issue", "npm cache clear fixes lockfile drift", "self-discovered")
  kb.storeFacts([{ topic: "npm cache", fact: "npm cache clear --force is faster" }], "web_search", "http://npm/1", "proj-A")

  const a = kb.findRelevant("npm cache clear", 5, "proj-A")
  expect(a.some(e => !e.scope)).toBe(true) // global entry survives scoped query
  expect(a.some(e => e.scope === "proj-A")).toBe(true)
})

test("K46: getActive and findByURL honor the scope filter", () => {
  kb.storeFacts([{ topic: "FIM API", fact: "FIM API works" }], "web_search", "http://u-a/1", "proj-A")
  kb.storeFacts([{ topic: "FIM API", fact: "FIM API broken" }], "web_search", "http://u-b/1", "proj-B")
  kb.store("generic", "generic problem", "generic solution", "self-discovered")

  const activeA = kb.getActive(10, "proj-A")
  expect(activeA.length).toBe(2) // proj-A + global
  expect(activeA.every(e => !e.scope || e.scope === "proj-A")).toBe(true)

  const activeAll = kb.getActive(10)
  expect(activeAll.length).toBe(3)

  expect(kb.findByURL("http://u-a/1", "proj-A")?.solution).toContain("works")
  expect(kb.findByURL("http://u-a/1", "proj-B")).toBeUndefined()
  expect(kb.findByURL("http://u-a/1")).toBeDefined() // unscoped: full store
})

test("K46: buildContext annotates scoped entries; unscoped output format unchanged", () => {
  kb.storeFacts([{ topic: "npm cache", fact: "npm cache clear fixes lockfile drift" }], "web_search", "http://npm/1", "proj-A")
  const scopedCtx = kb.buildContext("npm cache", "proj-A")
  expect(scopedCtx).toContain("（scope: proj-A）")
  expect(scopedCtx).toContain("npm cache clear fixes lockfile drift")

  // Unscoped entry → exact legacy format, no annotation
  const dir2 = mkdtempSync(join(tmpdir(), "orcana-kb-rc18-legacy-"))
  try {
    const kb2 = new KnowledgeBase(dir2)
    kb2.store("npm cache", "npm cache issue", "npm cache clear fixes lockfile drift", "self-discovered")
    expect(kb2.buildContext("npm cache")).toBe("## 已学知识: npm cache\nnpm cache clear fixes lockfile drift")
    kb2.close()
  } finally {
    rmSync(dir2, { recursive: true, force: true })
  }
})

test("K46: scope is persisted across reload", () => {
  kb.storeFacts([{ topic: "FIM API", fact: "FIM API works" }], "web_search", "http://u/1", "proj-A")
  kb.close()
  kb = new KnowledgeBase(dir)
  expect(kb.stats().entries).toBe(1)
  const hits = kb.findRelevant("FIM API", 5, "proj-A")
  expect(hits.length).toBe(1)
  expect(hits[0]!.scope).toBe("proj-A")
  expect(kb.findRelevant("FIM API", 5, "proj-B").length).toBe(0)
})

// ── K47: conflict resolution ──

test("K47: contradiction → only one side injected, loser moves to superseded history (auditable, persisted)", () => {
  kb.storeFacts([{ topic: "windows shell FIM support status", fact: "windows shell FIM support is available" }], "web_search", "http://ev/1")
  expect(kb.findRelevant("windows shell FIM support", 5).length).toBe(1)

  // Negation-flip contradiction: "is available" vs "is not available"
  const stored = kb.storeFacts([{ topic: "windows shell FIM support status", fact: "windows shell FIM support is not available" }], "web_search", "http://ev/2")
  expect(stored.length).toBe(1)

  const hits = kb.findRelevant("windows shell FIM support", 5)
  expect(hits.length).toBe(1) // never both
  expect(hits[0]!.solution).toContain("not available") // newer/incoming side wins
  const winnerId = hits[0]!.id

  // Loser preserved in auditable history, not deleted
  expect(kb.stats().entries).toBe(1)
  expect(kb.stats().superseded).toBe(1)
  expect(kb.getActive(10).length).toBe(1) // history never injected
  const hist = historyEntries(dir)
  expect(hist.length).toBe(1)
  expect(hist[0]!.solution).toContain("is available")
  expect(hist[0]!.supersededBy).toBe(winnerId)
  expect(typeof hist[0]!.supersededAt).toBe("number")

  // Persisted across reload
  kb.close()
  kb = new KnowledgeBase(dir)
  expect(kb.stats().superseded).toBe(1)
  const reloaded = kb.findRelevant("windows shell FIM support", 5)
  expect(reloaded.length).toBe(1)
  expect(reloaded[0]!.solution).toContain("not available")
})

test("K47: evidence-anchored (sourceURL) side wins a contradiction (K8 anchor)", () => {
  kb.storeFacts([{ topic: "windows shell FIM", fact: "windows shell FIM support is available" }], "web_search", "http://evidence/fim")
  // No sourceURL → no evidence; existing entry is evidence-anchored → it wins
  kb.storeFacts([{ topic: "windows shell FIM", fact: "windows shell FIM support is not available" }], "self-discovered")

  const hits = kb.findRelevant("windows shell FIM", 5)
  expect(hits.length).toBe(1)
  expect(hits[0]!.solution).toContain("is available") // old evidence-backed fact survives

  expect(kb.stats().superseded).toBe(1)
  const hist = historyEntries(dir)
  expect(hist.length).toBe(1)
  expect(hist[0]!.solution).toContain("is not available")
  expect(hist[0]!.supersededBy).toBe(hits[0]!.id)
})

test("K47: consistent update on the same topic → normal in-place replacement, no history", () => {
  kb.storeFacts([{ topic: "DeepSeek V4 context window", fact: "DeepSeek V4 supports 1M token context window with hybrid attention" }], "web_search", "http://ds/1")
  const first = kb.findRelevant("DeepSeek V4 context window", 5)[0]
  expect(first).toBeDefined()

  const stored = kb.storeFacts([{ topic: "DeepSeek V4 context window", fact: "DeepSeek V4 supports 1M token context window with hybrid attention and MLA" }], "web_search", "http://ds/2")

  expect(stored.length).toBe(1)
  expect(kb.stats().entries).toBe(1)
  expect(kb.stats().superseded).toBe(0)
  expect(existsSync(join(dir, "history.jsonl"))).toBe(false) // nothing superseded

  const hits = kb.findRelevant("DeepSeek V4 context window", 5)
  expect(hits.length).toBe(1)
  expect(hits[0]!.id).toBe(first!.id) // same entry replaced in place
  expect(hits[0]!.solution).toContain("MLA") // refreshed content
})

test("K47: same topic with different numeric answers → contradiction, newer side wins", () => {
  kb.storeFacts([{ topic: "DeepSeek V4 context window", fact: "DeepSeek V4 supports 1M token context window" }], "web_search", "http://ds/1")
  kb.storeFacts([{ topic: "DeepSeek V4 context window", fact: "DeepSeek V4 supports 128K token context window" }], "web_search", "http://ds/2")

  const hits = kb.findRelevant("DeepSeek V4 context window", 5)
  expect(hits.length).toBe(1)
  expect(hits[0]!.solution).toContain("128K")

  expect(kb.stats().superseded).toBe(1)
  expect(historyEntries(dir)[0]!.solution).toContain("1M")
})

test("K47: CJK contradiction (不支持 flip) is detected and resolved", () => {
  kb.storeFacts([{ topic: "deepseek 上下文窗口", fact: "deepseek 上下文窗口支持 1M token" }], "web_search", "http://cjk/1")
  kb.storeFacts([{ topic: "deepseek 上下文窗口", fact: "deepseek 上下文窗口不支持 1M token" }], "web_search", "http://cjk/2")

  const hits = kb.findRelevant("deepseek 上下文窗口", 5)
  expect(hits.length).toBe(1)
  expect(hits[0]!.solution).toContain("不支持")
  expect(kb.stats().superseded).toBe(1)
})

test("K47: different scopes never judge conflicts against each other", () => {
  kb.storeFacts([{ topic: "windows shell FIM", fact: "windows shell FIM support is available" }], "web_search", "http://a/1", "proj-A")
  kb.storeFacts([{ topic: "windows shell FIM", fact: "windows shell FIM support is not available" }], "web_search", "http://b/1", "proj-B")

  expect(kb.stats().entries).toBe(2)
  expect(kb.stats().superseded).toBe(0)

  expect(kb.findRelevant("windows shell FIM", 5, "proj-A")[0]!.solution).toContain("available")
  expect(kb.findRelevant("windows shell FIM", 5, "proj-B")[0]!.solution).toContain("not available")
})

test("K47: injection guard — store()-created contradictory pair is never parallel-injected", () => {
  // store() does no write-time resolution, so both stay in the store — the query-time
  // guard must still avoid injecting both conclusions for the same topic.
  kb.store("windows shell FIM", "state", "windows shell FIM works")
  kb.store("windows shell FIM", "state", "windows shell FIM broken")

  const hits = kb.findRelevant("windows shell FIM", 5)
  expect(hits.length).toBe(1) // one conclusion only
  expect(hits[0]!.solution).toMatch(/works|broken/)

  // Both entries remain in the store (nothing deleted by the guard)
  expect(kb.stats().entries).toBe(2)
  expect(kb.stats().superseded).toBe(0)
})

// ── non-regression ──

test("unscoped legacy flow behaves exactly as before (store/storeFacts/reconcile/stats)", () => {
  const facts: KeyFact[] = [
    { topic: "FIM API", fact: "FIM works on windows shell" },
    { topic: "npm cache", fact: "npm cache clear fixes lockfile drift" },
  ]
  const stored = kb.storeFacts(facts, "web_search", "http://legacy/1")
  expect(stored.length).toBe(2)

  kb.store("fim config", "fim config issue", "enable FIM config before retry", "self-discovered")

  expect(kb.findRelevant("FIM works", 5).length).toBeGreaterThanOrEqual(1)
  expect(kb.getActive(10).length).toBe(3)
  expect(kb.findByURL("http://legacy/1")).toBeDefined()
  expect(kb.stats().entries).toBe(3)
  expect(kb.stats().topics).toBe(3)
  expect(kb.stats().withSource).toBe(2)
  expect(kb.stats().superseded).toBe(0)

  const r = kb.reconcile()
  expect(r.pruned).toBe(0) // nothing expired
  expect(r.indexed).toBe(3)
  expect(kb.stats().entries).toBe(3)
})

test("reconcile keeps the superseded audit trail intact", () => {
  kb.storeFacts([{ topic: "windows shell FIM", fact: "windows shell FIM support is available" }], "web_search", "http://ev/1")
  kb.storeFacts([{ topic: "windows shell FIM", fact: "windows shell FIM support is not available" }], "web_search", "http://ev/2")
  expect(kb.stats().superseded).toBe(1)

  const r = kb.reconcile()
  expect(r.pruned).toBe(0)
  expect(kb.stats().superseded).toBe(1) // audit trail survives reconcile
  expect(historyEntries(dir).length).toBe(1)
})
