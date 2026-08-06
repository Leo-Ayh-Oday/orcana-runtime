import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ThinkingStore, type CompactOutput } from "../src/memory/thinking-store"

function makeStore(): { store: ThinkingStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "orcana-thinking-test-"))
  const store = new ThinkingStore(dir)
  return {
    store,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

describe("ThinkingStore.storeCompressed (K8 evidence binding)", () => {
  test("writes an Evidence: line into the stored text when evidence is provided", () => {
    const { store, cleanup } = makeStore()
    try {
      const output: CompactOutput = {
        key_insights: ["ki"],
        discarded: [],
        verified: ["verified-claim"],
        open: [],
        evidence: "tx=t1 state=s1 count=2 ledger=3",
      }
      const rec = store.storeCompressed({
        query: "q",
        compactOutput: output,
        roundRange: "r1-r3",
        filePattern: "src/a.ts",
        evidence: "tx=t1 state=s1 count=2 ledger=3",
      })
      expect(rec.kind).toBe("compressed_insight")
      expect(rec.reasoning).toContain("Evidence: tx=t1 state=s1 count=2 ledger=3")
      expect(rec.reasoning).toContain("- verified-claim")
      // 记录已持久化
      expect(store.getCompressedInsights().length).toBe(1)
    } finally {
      cleanup()
    }
  })

  test("falls back to compactOutput.evidence when the dedicated arg is omitted", () => {
    const { store, cleanup } = makeStore()
    try {
      const output: CompactOutput = {
        key_insights: [],
        discarded: [],
        verified: ["v"],
        open: [],
        evidence: "ledger=1",
      }
      store.storeCompressed({ query: "q", compactOutput: output, roundRange: "r1-r2", filePattern: "" })
      const rec = store.getCompressedInsights()[0]!
      expect(rec.reasoning).toContain("Evidence: ledger=1")
    } finally {
      cleanup()
    }
  })

  test("omits the Evidence line when no evidence is present (no regression)", () => {
    const { store, cleanup } = makeStore()
    try {
      const output: CompactOutput = { key_insights: ["ki"], discarded: [], verified: [], open: [] }
      const rec = store.storeCompressed({ query: "q", compactOutput: output, roundRange: "r1-r2", filePattern: "" })
      expect(rec.reasoning).not.toContain("Evidence:")
      expect(rec.reasoning).toContain("- ki")
    } finally {
      cleanup()
    }
  })
})

describe("ThinkingStore.mergeCompressedInsights (K8 evidence into cold memory)", () => {
  test("carries the evidence anchor into the merged cold memory text", () => {
    const { store, cleanup } = makeStore()
    try {
      const output: CompactOutput = {
        key_insights: [],
        discarded: [],
        verified: ["结论已验证"],
        open: [],
        evidence: "tx=t1 state=s1 count=2",
      }
      const res = store.mergeCompressedInsights("## 已有冷记忆\n- [✓] old <!-- 0 -->", output)
      expect(res.changed).toBe(true)
      expect(res.merged).toContain("Evidence: tx=t1 state=s1 count=2")
      expect(res.merged).toContain("- [✓] 结论已验证")
      // 既有条目保留
      expect(res.merged).toContain("- [✓] old")
    } finally {
      cleanup()
    }
  })

  test("without evidence the merged text is unchanged in behavior (no Evidence line, still merges)", () => {
    const { store, cleanup } = makeStore()
    try {
      const output: CompactOutput = { key_insights: [], discarded: [], verified: ["v1"], open: [] }
      const res = store.mergeCompressedInsights("", output)
      expect(res.changed).toBe(true)
      expect(res.merged).not.toContain("Evidence:")
      expect(res.merged).toContain("- [✓] v1")
    } finally {
      cleanup()
    }
  })
})
