import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ThinkingStore,
  evidenceToken,
  scorerCandidateText,
  truncateHeadTail,
  sanitizeReasoningForReplay,
  formatScorerCandidates,
  type CompactOutput,
  type ThinkingRecord,
} from "../src/memory/thinking-store"

function makeStore(namespace?: string): { store: ThinkingStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "orcana-ts-rc18-"))
  const store = namespace ? new ThinkingStore(dir, namespace) : new ThinkingStore(dir)
  return {
    store,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const DAY = 86400000
const HOUR = 3600000

// ─────────────────────────── K10 项目命名空间隔离 ───────────────────────────

describe("K10 THINKING_NAMESPACED_BY_PROJECT", () => {
  test("namespaced stores isolate reads/writes in the same directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "orcana-ts-ns-"))
    try {
      const a = new ThinkingStore(dir, "proj-a")
      const b = new ThinkingStore(dir, "proj-b")
      const recA = a.store("alphaquery", "reasoning-a")
      const recB = b.store("betaquery", "reasoning-b")
      a.storeThinking({ query: "chain-q", thinkingBlocks: [{ thinking: "chain-a", signature: "s" }], roundNum: 1, filePattern: "", tags: [] })

      expect(a.stats().totalRecords).toBe(2)
      expect(b.stats().totalRecords).toBe(1)
      // 隔离断言（基于记录身份）：A 的检索结果绝不包含 B 的记录，反之亦然
      // 注：findSimilar 的 age bonus 无条件加分，故不做计数断言，只断言不跨命名空间
      expect(a.findSimilar("alphaquery").some(r => r.id === recB.id)).toBe(false)
      expect(a.findSimilar("betaquery").some(r => r.id === recB.id)).toBe(false)
      expect(a.findSimilar("alphaquery").every(r => r.namespace === "proj-a")).toBe(true)
      expect(b.findSimilar("betaquery").some(r => r.id === recA.id)).toBe(false)
      expect(b.findSimilar("alphaquery").some(r => r.id === recA.id)).toBe(false)
      expect(b.findSimilar("betaquery").every(r => r.namespace === "proj-b")).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("records carry their namespace; default constructor keeps __global__ (backward compat)", () => {
    const dir = mkdtempSync(join(tmpdir(), "orcana-ts-ns2-"))
    try {
      const g = new ThinkingStore(dir)
      const rec = g.store("globalquery", "gr")
      expect(rec.namespace).toBe("__global__")
      // 同名目录下新建 store 都能看到 __global__ 记录
      expect(new ThinkingStore(dir).stats().totalRecords).toBe(1)
      // 具名 store 看不到 __global__ 记录
      expect(new ThinkingStore(dir, "proj-x").stats().totalRecords).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("legacy records (no namespace field) belong to __global__", () => {
    const dir = mkdtempSync(join(tmpdir(), "orcana-ts-ns3-"))
    try {
      writeFileSync(
        join(dir, "records.jsonl"),
        JSON.stringify({
          id: "legacy1",
          timestamp: Date.now(),
          problemType: "debug",
          queryHash: "h",
          queryPreview: "legacyquery",
          reasoning: "old reasoning",
          tokens: 5,
          filePattern: "",
          tags: [],
          kind: "tool_result",
        }) + "\n",
        "utf-8",
      )
      expect(new ThinkingStore(dir).stats().totalRecords).toBe(1)
      expect(new ThinkingStore(dir, "proj-x").stats().totalRecords).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────── K42 检索 binding 过滤 ───────────────────────────

describe("K42 THINKING_RETRIEVAL_NAMESPACED", () => {
  test("write binding then retrieve with binding filter; no binding returns all", () => {
    const { store, cleanup } = makeStore()
    try {
      const bound = store.store("alphaquery", "r1", "debug", "", [], { workspace: "w1", commit: "c1", model: "m1" })
      const w2rec = store.store("betaquery", "r2", "debug", "", [], { workspace: "w2" })
      const w1c2 = store.store("gammaquery", "r3", "debug", "", [], { workspace: "w1", commit: "c2" })
      const idsOf = (recs: ThinkingRecord[]) => recs.map(r => r.id).sort()

      // 无 binding：全量返回（向后兼容）
      expect(store.findSimilar("anything", undefined, "", 10).length).toBe(3)

      // workspace 过滤
      expect(idsOf(store.findSimilar("anything", undefined, "", 10, { workspace: "w1" }))).toEqual([bound.id, w1c2.id].sort())
      expect(idsOf(store.findSimilar("anything", undefined, "", 10, { workspace: "w2" }))).toEqual([w2rec.id])

      // 多字段过滤
      expect(idsOf(store.findSimilar("anything", undefined, "", 10, { workspace: "w1", commit: "c2" }))).toEqual([w1c2.id])
      expect(idsOf(store.findSimilar("anything", undefined, "", 10, { workspace: "w1", commit: "c1" }))).toEqual([bound.id])

      // 严格语义：记录缺失绑定字段时视为不匹配（旧数据不串入新上下文）
      expect(idsOf(store.findSimilar("anything", undefined, "", 10, { model: "m1" }))).toEqual([bound.id])
    } finally {
      cleanup()
    }
  })

  test("binding filters storeThinking and storeCompressed records too", () => {
    const { store, cleanup } = makeStore()
    try {
      store.storeThinking({
        query: "chain-q",
        thinkingBlocks: [{ thinking: "t", signature: "s" }],
        roundNum: 1,
        filePattern: "",
        tags: [],
        binding: { workspace: "w1" },
      })
      store.storeCompressed({
        query: "q",
        compactOutput: { key_insights: ["ki"], discarded: [], verified: [], open: [] },
        roundRange: "r1-r2",
        filePattern: "",
        binding: { workspace: "w2" },
      })
      expect(store.getRecentChains(undefined, 10, { workspace: "w1" }).length).toBe(1)
      expect(store.getRecentChains(undefined, 10, { workspace: "w2" }).length).toBe(0)
      expect(store.getCompressedInsights({ workspace: "w1" }).length).toBe(0)
      expect(store.getCompressedInsights({ workspace: "w2" }).length).toBe(1)
      // 不传 binding：全量
      expect(store.getRecentChains().length).toBe(1)
      expect(store.getCompressedInsights().length).toBe(1)
    } finally {
      cleanup()
    }
  })
})

// ─────────────────────────── K43 Semantic Scorer 完整候选 ───────────────────────────

const STRONG_PHRASE = "重写缓存预热逻辑并删除陈旧状态"
const STRONG_REASONING = "检查完成。执行了多种排查方案但没有结论。唯一解法是" + STRONG_PHRASE + "，问题即消失。"

describe("K43 SEMANTIC_SCORER_FULL_CANDIDATE", () => {
  test("scorerCandidateText exposes the reasoning body; 80-char queryPreview does not", () => {
    const rec: ThinkingRecord = {
      id: "r1",
      timestamp: Date.now(),
      problemType: "debug",
      queryHash: "h",
      queryPreview: "缓存失效导致的启动失败 任务六",
      reasoning: STRONG_REASONING,
      tokens: 100,
      filePattern: "",
      tags: [],
      kind: "thinking_chain",
    }
    expect(rec.queryPreview.slice(0, 80)).not.toContain(STRONG_PHRASE) // 旧实现看不到正文信号
    expect(scorerCandidateText(rec)).toContain(STRONG_PHRASE)          // 新实现能看到
    expect(scorerCandidateText(rec)).toContain("推理: ")
  })

  test("truncateHeadTail keeps head and tail with an omission marker", () => {
    const long = "开头事实A。" + "无信号填充。".repeat(200) + "结尾关键解法是重写缓存预热逻辑。"
    const out = truncateHeadTail(long, 600)
    expect(out).toContain("开头事实A")
    expect(out).toContain("结尾关键解法是重写缓存预热逻辑")
    expect(out).toContain("中略")
    expect(out.length).toBeLessThanOrEqual(700)
    // 未超长时原样返回
    expect(truncateHeadTail("短文本", 600)).toBe("短文本")
  })

  test("formatScorerCandidates keeps the 候选N shape with full content", () => {
    const rec: ThinkingRecord = {
      id: "r2", timestamp: Date.now(), problemType: "debug", queryHash: "h",
      queryPreview: "缓存失效导致的启动失败", reasoning: STRONG_REASONING,
      tokens: 100, filePattern: "", tags: [], kind: "thinking_chain",
    }
    const text = formatScorerCandidates([rec], { perCandidateChars: 600 })
    expect(text).toContain("候选1: ")
    expect(text).toContain("问题: 缓存失效导致的启动失败")
    expect(text).toContain(STRONG_PHRASE)
  })

  test("old preview-only scorer misses the strong candidate; full-content scorer hits it", async () => {
    const { store, cleanup } = makeStore()
    try {
      const ids: string[] = []
      for (let i = 0; i < 6; i++) {
        const rec = store.store(`缓存失效导致的启动失败 任务${i + 1}`, "普通排查记录。", "debug")
        ids.push(rec.id)
      }
      // 任务六 的记录：强语义信号只存在于 reasoning 正文（queryPreview 无信号）
      const strong = store.store("缓存失效导致的启动失败 任务六", STRONG_REASONING, "debug")
      ids[5] = strong.id

      // 旧式 scorer（只看 queryPreview 前 80 字符）——任务六 在预览里没有任何强信号
      const oldScorer = async (_q: string, candidates: ThinkingRecord[]) =>
        candidates.map(c => c.queryPreview.includes("任务六") ? 1 : 7)
      // 新式 scorer（完整/放大候选内容）
      const newScorer = async (_q: string, candidates: ThinkingRecord[]) =>
        candidates.map(c => scorerCandidateText(c).includes(STRONG_PHRASE) ? 9 : 6)

      const oldResult = await store.findSimilarSemantic("缓存失效导致的启动失败", oldScorer, undefined, undefined, 5)
      expect(oldResult.map(r => r.id)).not.toContain(strong.id) // 旧实现漏检

      const newResult = await store.findSimilarSemantic("缓存失效导致的启动失败", newScorer, undefined, undefined, 5)
      expect(newResult.map(r => r.id)).toContain(strong.id)     // 新实现命中
      expect(newResult[0]!.id).toBe(strong.id)                  // 且排第一
    } finally {
      cleanup()
    }
  })
})

// ─────────────────────────── K44 注入前清洗（不重放原始 <think>） ───────────────────────────

describe("K44 NO_RAW_THINK_REPLAY", () => {
  const CHAIN = [
    "我先尝试方案A，然后检查日志。",
    "我猜测错误来自网络超时。",
    "日志显示数据库连接池耗尽。",
    "真正原因是连接池太小，需要扩大池大小。",
  ].join("")

  test("sanitizeReasoningForReplay strips think tags, process narration and wrong hypotheses", () => {
    const raw = `<think>${CHAIN}</think>`
    const { conclusion, facts } = sanitizeReasoningForReplay(raw)
    expect(conclusion).toContain("真正原因是连接池太小") // 一句话结论取最后一处有效结论
    expect(facts.join(" ")).toContain("日志显示数据库连接池耗尽")
    expect(conclusion + facts.join("")).not.toContain("我猜测") // 错误假设剔除
    expect(conclusion + facts.join("")).not.toContain("我先尝试") // 过程性叙述剔除
    expect(sanitizeReasoningForReplay("").conclusion).toBe("")
  })

  test("formatForVolatileContext injects sanitized conclusion+facts with source annotation, no think markers", () => {
    const { store, cleanup } = makeStore()
    try {
      store.storeThinking({
        query: "修复数据库连接池问题",
        thinkingBlocks: [{ thinking: `<think>${CHAIN}</think>`, signature: "s" }],
        roundNum: 3,
        filePattern: "src/db.ts",
        tags: ["db"],
        toolContext: ["git diff", "grep"],
      })
      const recs = store.getRecentChains()
      expect(recs.length).toBe(1)
      const out = store.formatForVolatileContext(recs)

      expect(out).toContain("## Historical Context（本轮相关）")
      expect(out).toContain("### Round 3 [db] — 修复数据库连接池问题（来自 round 3 推理）") // 来源标注
      expect(out).toContain("结论: 真正原因是连接池太小，需要扩大池大小。")
      expect(out).toContain("关键事实:")
      expect(out).toContain("- 日志显示数据库连接池耗尽。")
      expect(out).toContain("**工具:** git diff, grep")
      // 铁律：无 <think> 标记、无错误假设、无过程性推理
      expect(out).not.toContain("<think>")
      expect(out).not.toContain("</think>")
      expect(out).not.toContain("我猜测")
      expect(out).not.toContain("我先尝试")
    } finally {
      cleanup()
    }
  })

  test("formatForPrompt injects sanitized content, headers preserved", () => {
    const { store, cleanup } = makeStore()
    try {
      store.storeThinking({
        query: "修复数据库连接池问题",
        thinkingBlocks: [{ thinking: CHAIN, signature: "s" }],
        roundNum: 1,
        filePattern: "",
        tags: [],
      })
      const out = store.formatForPrompt(store.getRecentChains())
      expect(out).toContain("## Similar Past Reasoning") // 段标题契约不变
      expect(out).toContain("### Example 1: reasoning — ")
      expect(out).toContain("结论: 真正原因是连接池太小，需要扩大池大小。")
      expect(out).not.toContain("<think>")
      expect(out).not.toContain("我猜测")
    } finally {
      cleanup()
    }
  })
})

// ─────────────────────────── K45 Evidence supersede（时间衰减只降权） ───────────────────────────

describe("K45 MEMORY_SUPERSEDE_BY_EVIDENCE", () => {
  const ev1 = evidenceToken("evidence-1")!
  const ev2 = evidenceToken("evidence-2")!

  test("same topic with different evidence: newer evidence supersedes, old sinks", () => {
    const { store, cleanup } = makeStore()
    try {
      const oldTs = Date.now() - DAY // 1 天前，未触发时间衰减
      const existing = `- [✓] 缓存预热无效 <!-- ${oldTs}:e:${ev1} -->`
      const res = store.mergeCompressedInsights(existing, {
        key_insights: [],
        discarded: [],
        verified: ["缓存预热无效"],
        open: [],
        evidence: "evidence-2",
      })
      expect(res.changed).toBe(true)
      expect(res.merged).toContain(`:e:${ev2}`) // 新 evidence 生效
      expect(res.merged).not.toContain(ev1)     // 旧的 evidence 锚沉掉
      expect(res.merged.match(/缓存预热无效/g)!.length).toBe(1) // 无重复条目
    } finally {
      cleanup()
    }
  })

  test("unbound old entry is overtaken by a newer evidence-bearing entry", () => {
    const { store, cleanup } = makeStore()
    try {
      const existing = `- [✓] 主题E <!-- ${Date.now() - DAY} -->` // 无证据绑定
      const res = store.mergeCompressedInsights(existing, {
        key_insights: [],
        discarded: [],
        verified: ["主题E"],
        open: [],
        evidence: "evidence-2",
      })
      expect(res.changed).toBe(true)
      expect(res.merged.match(/主题E/g)!.length).toBe(1)
      expect(res.merged).toContain(`:e:${ev2}`)
    } finally {
      cleanup()
    }
  })

  test("evidence-bound conclusion cannot be overturned by evidence-less output (protected, no duplicate)", () => {
    const { store, cleanup } = makeStore()
    try {
      const existing = `- [✓] 主题F <!-- ${Date.now() - DAY}:e:${ev1} -->`
      const res = store.mergeCompressedInsights(existing, {
        key_insights: [],
        discarded: [],
        verified: ["主题F"],
        open: [],
        // 无新 evidence——不能推翻带 evidence 的旧结论
      })
      expect(res.changed).toBe(false)
      expect(res.merged).toBe(existing)
      expect(res.merged).toContain(`:e:${ev1}`)
    } finally {
      cleanup()
    }
  })

  test("evidence-bound conclusion is immune to time decay (15 days old, still kept)", () => {
    const { store, cleanup } = makeStore()
    try {
      const existing = `- [✓] 结论C <!-- ${Date.now() - 15 * DAY}:e:${ev1} -->`
      const res = store.mergeCompressedInsights(existing, {
        key_insights: ["无关洞察"],
        discarded: [],
        verified: [],
        open: [],
      })
      expect(res.changed).toBe(true)
      expect(res.merged).toContain(`- [✓] 结论C`) // 不被时间衰减删除/降权
      expect(res.merged).not.toContain("- [·] 结论C")
    } finally {
      cleanup()
    }
  })

  test("evidence-less old entry decays to insight (demoted, NOT deleted)", () => {
    const { store, cleanup } = makeStore()
    try {
      const existing = `- [✓] 结论D <!-- ${Date.now() - 15 * DAY} -->`
      const res = store.mergeCompressedInsights(existing, {
        key_insights: ["无关洞察2"],
        discarded: [],
        verified: [],
        open: [],
      })
      expect(res.changed).toBe(true)
      expect(res.merged).toContain("- [·] 结论D") // 降权为洞察
      expect(res.merged).not.toContain("- [✓] 结论D")
      expect(res.merged).toContain("结论D")       // 仍在，未被删除
    } finally {
      cleanup()
    }
  })

  test("auto-resolve of open issues requires an evidence anchor (absence alone never resolves)", () => {
    const { store, cleanup } = makeStore()
    try {
      const existing = `- [?] 待解决问题 <!-- ${Date.now() - 2 * HOUR} -->`
      // 带 evidence：缺席 + 超 1 小时 → evidence 背书 resolved
      const withEv = store.mergeCompressedInsights(existing, {
        key_insights: [],
        discarded: [],
        verified: ["其他结论"],
        open: [],
        evidence: "evidence-r",
      })
      expect(withEv.merged).toContain("## 已解决")
      expect(withEv.merged).toContain("- [✓✓ resolved] 待解决问题")
      expect(withEv.merged).not.toContain("- [?] 待解决问题")
    } finally {
      cleanup()
    }
  })

  test("no evidence -> open issue stays open (no pseudo-resolution by absence)", () => {
    const { store, cleanup } = makeStore()
    try {
      const existing = `- [?] 待解决问题 <!-- ${Date.now() - 2 * HOUR} -->`
      const noEv = store.mergeCompressedInsights(existing, {
        key_insights: [],
        discarded: [],
        verified: ["其他"],
        open: [],
      })
      expect(noEv.merged).toContain("- [?] 待解决问题")
      expect(noEv.merged).not.toContain("[✓✓ resolved]")
    } finally {
      cleanup()
    }
  })

  test("fresh evidence on the same run is carried into merged entry comments (K45 + K8 interplay)", () => {
    const { store, cleanup } = makeStore()
    try {
      const res = store.mergeCompressedInsights("", {
        key_insights: ["关键洞察A"],
        discarded: [],
        verified: ["结论已验证"],
        open: ["待跟进"],
        evidence: "tx=t1 state=s1",
      })
      expect(res.changed).toBe(true)
      expect(res.merged).toContain(`Evidence: tx=t1 state=s1`)
      const tok = evidenceToken("tx=t1 state=s1")!
      expect(res.merged).toContain(`:e:${tok}`) // 新条目带条目级证据 token
    } finally {
      cleanup()
    }
  })
})
