/** LR2-2（P2-B）：CAS 验收 —— 写入/读取/碰撞/并发/污染拒绝/evict 幂等。 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ContentAddressedStore } from "../../../../src/runtime/linux/cache/cas"
import { createHash } from "node:crypto"

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "cas-"))
  const cas = new ContentAddressedStore({ root: dir })
  return { dir, cas, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function digestOf(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

describe("ContentAddressedStore (P2-B)", () => {
  test("put → read roundtrip with VALID state", () => {
    const { cas, cleanup } = setup()
    try {
      const content = Buffer.from("repo-map-data")
      const result = cas.put(content, { ok: true, runId: "r1", cellId: "c1" })
      expect(result).toBe("published")
      const digest = digestOf("repo-map-data")
      expect(cas.hasValid(digest)).toBe(true)
      expect(cas.read(digest)!.toString()).toBe("repo-map-data")
      const record = cas.record(digest)!
      expect(record.state).toBe("VALID")
      expect(record.producerCellId).toBe("c1")
    } finally {
      cleanup()
    }
  })

  test("same digest same content is idempotent", () => {
    const { cas, cleanup } = setup()
    try {
      const content = Buffer.from("x")
      expect(cas.put(content, { ok: true })).toBe("published")
      expect(cas.put(content, { ok: true })).toBe("existing")
      expect(cas.size).toBe(1)
    } finally {
      cleanup()
    }
  })

  test("failed producer content is quarantined, never readable (FAILED_CELL_POLLUTES_CACHE)", () => {
    const { cas, cleanup } = setup()
    try {
      const content = Buffer.from("poison")
      const result = cas.put(content, { ok: false, runId: "r-bad", cellId: "c-bad" })
      expect(result).toBe("quarantined")
      const digest = digestOf("poison")
      expect(cas.hasValid(digest)).toBe(false)
      expect(cas.read(digest)).toBeUndefined()
      expect(cas.record(digest)!.state).toBe("QUARANTINED")
    } finally {
      cleanup()
    }
  })

  test("quarantined object never promotes to readable (CACHE_POISON_PROMOTION)", () => {
    const { cas, cleanup } = setup()
    try {
      const content = Buffer.from("bad")
      cas.put(content, { ok: false })
      const digest = digestOf("bad")
      // 重试写入（同内容、producer 现在 ok）→ 仍拒绝（QUARANTINED 不自动恢复）
      const result = cas.put(content, { ok: true })
      expect(result).toBe("quarantined")
      expect(cas.hasValid(digest)).toBe(false)
    } finally {
      cleanup()
    }
  })

  test("evict is idempotent and removes object + manifest", () => {
    const { cas, cleanup } = setup()
    try {
      const content = Buffer.from("evict-me")
      cas.put(content, { ok: true })
      const digest = digestOf("evict-me")
      expect(cas.evict(digest)).toBe(true)
      expect(cas.read(digest)).toBeUndefined()
      expect(cas.evict(digest)).toBe(false) // 幂等
    } finally {
      cleanup()
    }
  })

  test("manifest survives reopen (persistence)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cas-"))
    try {
      const cas1 = new ContentAddressedStore({ root: dir })
      cas1.put(Buffer.from("persist"), { ok: true, runId: "r" })
      const cas2 = new ContentAddressedStore({ root: dir })
      expect(cas2.hasValid(digestOf("persist"))).toBe(true)
      expect(cas2.read(digestOf("persist"))!.toString()).toBe("persist")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("concurrent double-write does not corrupt (CONCURRENT_CACHE_WRITE_CORRUPT)", async () => {
    const { cas, cleanup } = setup()
    try {
      const content = Buffer.from("concurrent")
      const results = await Promise.all([
        Promise.resolve().then(() => cas.put(content, { ok: true })),
        Promise.resolve().then(() => cas.put(content, { ok: true })),
        Promise.resolve().then(() => cas.put(content, { ok: true })),
      ])
      expect(results.every(r => r === "published" || r === "existing")).toBe(true)
      // 内容完整无损坏
      expect(cas.read(digestOf("concurrent"))!.toString()).toBe("concurrent")
    } finally {
      cleanup()
    }
  })
})
