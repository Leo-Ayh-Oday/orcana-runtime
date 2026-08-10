/** IC01: BoundedFileReader —— 有界读取（stat/range/chunk/流式哈希/abort/
 *  二进制检测/单文件限制/操作级字节预算）。
 *
 *  不变式（完成 Gate）：
 *    - RANGE_READ_FULL_ALLOCATION = 0 —— 1 GiB sparse 文件 range read 只分配
 *      请求字节，RSS 不得增长 1 GiB。
 *    - UNBOUNDED_RUNTIME_FILE_READ = 0 —— 全量读取受 maxFileBytes 上限；
 *      单次操作受 operationBudgetBytes 上限。
 *    - 只读普通文件：目录/非普通文件拒绝（NOT_REGULAR_FILE）。
 *    - AbortSignal：操作前与每个 chunk 边界检查；onChunk 钩子可确定性
 *      模拟流式中止。
 *    - 流式 sha256 与 fingerprintContent 全量哈希一致。
 *    - NUL 嗅探：前 binaryProbeBytes 内 NUL → binary。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { open, stat } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BoundedFileReader, FileReadError } from "../../src/runtime/io/bounded-file-reader"
import { fingerprintContent } from "../../src/file-state"

const GIB = 1024 * 1024 * 1024
const MIB = 1024 * 1024

let ROOT = ""
let SPARSE = ""

beforeAll(async () => {
  ROOT = mkdtempSync(join(tmpdir(), "orcana-ic01-bfr-"))
  mkdirSync(join(ROOT, "src"), { recursive: true })
  writeFileSync(join(ROOT, "src", "small.txt"), "line one\nline two\nline three\nline four\n", "utf-8")
  writeFileSync(join(ROOT, "src", "binary.bin"), "AB\u0000CD", "utf-8")
  // 1 GiB sparse 文件：开头写入约 10 KiB 文本行（跨过 8 KiB 嗅探窗口），
  // 其余为空洞（不占物理块）。
  SPARSE = join(ROOT, "sparse-1gib.txt")
  const fd = await open(SPARSE, "w")
  try {
    // 头部文本必须超过 8 KiB 二进制嗅探窗口（否则空洞零字节触发 binary）。
    const head = Array.from({ length: 1200 }, (_, i) => `sparse line ${i} 0123456789`).join("\n") + "\n"
    await fd.write(head, 0, "utf-8")
    await fd.truncate(GIB)
  } finally {
    await fd.close()
  }
})

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

describe("IC01 fixture: sparse file is actually sparse", () => {
  test("1 GiB 文件物理占用远小于逻辑大小（< 1 MiB）", async () => {
    const info = await stat(SPARSE)
    expect(info.size).toBe(GIB)
    expect(info.blocks * 512).toBeLessThan(MIB)
  })
})

describe("IC01 BoundedFileReader.readRange — RANGE_READ_FULL_ALLOCATION = 0", () => {
  test("1 GiB sparse 文件 range read 只分配请求字节，RSS 无 1 GiB 增长", async () => {
    const reader = new BoundedFileReader()
    const before = process.memoryUsage().rss
    // 头部文本约 35 KiB，offset 深入空洞区（1 MiB 之后）确保读到的全是 0。
    const result = await reader.readRange(SPARSE, MIB, 4096)
    const after = process.memoryUsage().rss

    expect(result.byteCount).toBe(4096)
    expect(result.buffer.length).toBe(4096)
    expect(result.totalBytes).toBe(GIB)
    // 读完稀疏区间的空洞：全部为 0x00。
    expect(result.buffer.every(b => b === 0)).toBe(true)
    // 绝不允许分配/读入 1 GiB：RSS 增长远小于 64 MiB。
    expect(after - before).toBeLessThan(64 * MIB)
  })

  test("range 长度超过操作预算 → 按预算截断（truncated=true），不放大分配", async () => {
    const reader = new BoundedFileReader({ operationBudgetBytes: 256 * 1024 })
    const result = await reader.readRange(SPARSE, 0, GIB)
    expect(result.truncated).toBe(true)
    expect(result.byteCount).toBeLessThanOrEqual(256 * 1024)
    expect(result.buffer.length).toBeLessThanOrEqual(256 * 1024)
  })

  test("offset 越界 → 空 buffer（不分配、不报错）", async () => {
    const reader = new BoundedFileReader()
    const result = await reader.readRange(SPARSE, GIB + 1, 1024)
    expect(result.byteCount).toBe(0)
    expect(result.buffer.length).toBe(0)
  })

  test("窗口内的文本 range 精确返回（sparse 文件头部）", async () => {
    const reader = new BoundedFileReader()
    const result = await reader.readRange(SPARSE, 0, 12)
    expect(result.buffer.toString("utf-8")).toBe("sparse line ")
    expect(result.byteCount).toBe(12)
  })
})

describe("IC01 BoundedFileReader.readFile — UNBOUNDED_RUNTIME_FILE_READ = 0", () => {
  test("全量读取受 maxFileBytes 上限（1 GiB sparse → 只读 16 MiB，truncated）", async () => {
    const reader = new BoundedFileReader()
    const result = await reader.readFile(SPARSE)
    expect(result.truncated).toBe(true)
    expect(result.buffer.length).toBe(reader.maxFileBytes)
    expect(result.byteCount).toBe(reader.maxFileBytes)
    expect(result.totalBytes).toBe(GIB)
  })

  test("自定义 maxFileBytes 生效（1 MiB 上限）", async () => {
    const reader = new BoundedFileReader({ maxFileBytes: MIB })
    const result = await reader.readFile(SPARSE)
    expect(result.truncated).toBe(true)
    expect(result.buffer.length).toBe(MIB)
  })

  test("流式 sha256 与 fingerprintContent 全量哈希一致", async () => {
    const reader = new BoundedFileReader()
    const result = await reader.readFile(join(ROOT, "src", "small.txt"))
    expect(result.truncated).toBe(false)
    const content = await import("node:fs/promises").then(m => m.readFile(join(ROOT, "src", "small.txt")))
    expect(result.sha256).toBe(fingerprintContent(content).sha256)
    expect(result.buffer.toString("utf-8")).toBe(content.toString("utf-8"))
  })

  test("操作级字节预算：单次 readFile 累计不超过 budget", async () => {
    const reader = new BoundedFileReader({ maxFileBytes: GIB, operationBudgetBytes: 1024 })
    const result = await reader.readFile(SPARSE)
    expect(result.byteCount).toBeLessThanOrEqual(1024)
    expect(result.truncated).toBe(true)
  })
})

describe("IC01 BoundedFileReader: stat / 普通文件 / abort / 二进制", () => {
  test("目录与非普通文件 → NOT_REGULAR_FILE", async () => {
    const reader = new BoundedFileReader()
    await expect(reader.readFile(ROOT)).rejects.toThrow(FileReadError)
    await expect(reader.readFile(ROOT)).rejects.toMatchObject({ code: "NOT_REGULAR_FILE" })
    const info = await reader.stat(ROOT)
    expect(info.isRegular).toBe(false)
  })

  test("操作前已 abort → ABORTED", async () => {
    const reader = new BoundedFileReader()
    const controller = new AbortController()
    controller.abort()
    await expect(reader.readFile(join(ROOT, "src", "small.txt"), { signal: controller.signal }))
      .rejects.toMatchObject({ code: "ABORTED" })
    await expect(reader.readRange(SPARSE, 0, 1024, { signal: controller.signal }))
      .rejects.toMatchObject({ code: "ABORTED" })
  })

  test("流式中止：第二个 chunk 边界 abort → ABORTED（onChunk 确定性钩子）", async () => {
    const reader = new BoundedFileReader({ maxFileBytes: GIB, chunkSize: 1024 })
    const controller = new AbortController()
    let chunksSeen = 0
    const promise = reader.readFile(SPARSE, {
      signal: controller.signal,
      onChunk: (_bytes, index) => {
        chunksSeen = index
        if (index === 2) controller.abort()
      },
    })
    await expect(promise).rejects.toMatchObject({ code: "ABORTED" })
    expect(chunksSeen).toBe(2)
  })

  test("NUL 字节二进制嗅探（binary=true）", async () => {
    const reader = new BoundedFileReader()
    const result = await reader.readFile(join(ROOT, "src", "binary.bin"))
    expect(result.binary).toBe(true)
  })

  test("纯文本文件 binary=false", async () => {
    const reader = new BoundedFileReader()
    const result = await reader.readFile(join(ROOT, "src", "small.txt"))
    expect(result.binary).toBe(false)
  })
})

describe("IC01 BoundedFileReader.readSync（同步管线）", () => {
  test("同步有界读取：只分配 limit 字节", async () => {
    const reader = new BoundedFileReader()
    const buffer = reader.readSync(join(ROOT, "src", "small.txt"), 8)
    expect(buffer.length).toBe(8)
    expect(buffer.toString("utf-8")).toBe("line one")
  })

  test("同步读取超限截断（sparse 1 GiB → maxFileBytes）", async () => {
    const reader = new BoundedFileReader({ maxFileBytes: 4096 })
    const buffer = reader.readSync(SPARSE, GIB)
    expect(buffer.length).toBe(4096)
  })
})

describe("IC01 read_file 行窗口（工具级）—— 不分配整个文件", () => {
  test("1 GiB sparse 文件 offset/limit 读取：只读窗口字节，RSS 无 1 GiB 增长", async () => {
    const { buildTool } = await import("../../src/tools/registry")
    const { READ_FILE } = await import("../../src/tools/file")
    const read = buildTool(READ_FILE)
    const before = process.memoryUsage().rss
    const result = await read.execute({ path: SPARSE, offset: 2, limit: 1 }, { projectRoot: ROOT })
    const after = process.memoryUsage().rss

    expect(result.success).toBe(true)
    expect(result.content).toContain("sparse line 2")
    expect(result.metadata?.lines).toBe(1)
    // 超限文件不给 total（未扫描到 EOF）。
    expect((result.metadata as { total?: number }).total).toBeUndefined()
    expect(after - before).toBeLessThan(64 * MIB)
  })

  test("二进制文件读取 → 二进制注记，不倾倒原始字节", async () => {
    const { buildTool } = await import("../../src/tools/registry")
    const { READ_FILE } = await import("../../src/tools/file")
    const read = buildTool(READ_FILE)
    const result = await read.execute({ path: "src/binary.bin" }, { projectRoot: ROOT })
    expect(result.success).toBe(true)
    expect(result.content).toContain("<binary file")
    expect(result.metadata?.binary).toBe(true)
    expect(result.content).not.toContain("AB\u0000CD")
  })

  test("offset/limit 行窗口内容与旧 slice 语义一致（小型文件）", async () => {
    const { buildTool } = await import("../../src/tools/registry")
    const { READ_FILE } = await import("../../src/tools/file")
    const read = buildTool(READ_FILE)
    const result = await read.execute({ path: "src/small.txt", offset: 1, limit: 2 }, { projectRoot: ROOT })
    expect(result.success).toBe(true)
    expect(result.content).toContain("line two\nline three")
    expect(result.metadata?.lines).toBe(2)
    // 旧 split 语义含尾部空行：4 行文本 + 尾随空元素 = 5。
    expect(result.metadata?.total).toBe(5)
  })

  test("selector byte_range 不完整分配（sparse 文件直接 range read）", async () => {
    const { buildTool } = await import("../../src/tools/registry")
    const { READ_FILE } = await import("../../src/tools/file")
    const read = buildTool(READ_FILE)
    const result = await read.execute(
      { path: SPARSE, selector: { kind: "byte_range", start: 0, length: 12 } },
      { projectRoot: ROOT },
    )
    expect(result.success).toBe(true)
    expect(result.content).toBe("sparse line ")
    expect(result.metadata?.bytes).toBe(12)
  })
})
