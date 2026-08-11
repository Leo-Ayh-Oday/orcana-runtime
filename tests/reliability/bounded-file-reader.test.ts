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
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs"
import { open, stat } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BoundedFileReader, FileReadError } from "../../src/runtime/io/bounded-file-reader"
import { fingerprintContent } from "../../src/file-state"

/** ext4 的 mtime/ctime 是 jiffy 粒度 —— 单次写入可能与 open 落在同一 jiffy，
 *  时间戳比较会不确定。重复同内容写入直到 mtime 越过下一个 jiffy 边界，
 *  保证最终写入后的 mtime 与 open 时（更早 jiffy）不同 → SNAPSHOT_CHANGED
 *  判定确定性。 */
async function rewriteUntilTick(path: string, content: string): Promise<void> {
  writeFileSync(path, content)
  const first = statSync(path).mtimeMs
  for (let i = 0; i < 200; i++) {
    await new Promise(resolve => setTimeout(resolve, 5))
    writeFileSync(path, content)
    if (statSync(path).mtimeMs !== first) return
  }
  throw new Error(`mtime did not advance for ${path}`)
}

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
      onChunk: (_position, _bytes, index) => {
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

  test("P0-3: 1 GiB sparse 文件 offset>0 无 limit → 窗口有界（扫描/返回双重预算，无巨型分配）", async () => {
    const reader = new BoundedFileReader()
    const result = await reader.readLineWindow(SPARSE, 1, Number.POSITIVE_INFINITY, {
      maxReturnBytes: 4096,
      scanBudgetBytes: 128 * 1024,
    })
    expect(result.truncated).toBe(true)
    expect(result.text.length).toBeLessThanOrEqual(4096)
    // 预算耗尽 → 未到 EOF，不能给出精确 totalLines。
    expect(result.scannedToEof).toBe(false)
    expect(result.totalLines).toBeNull()
  })

  test("P0-3: 极长单行 → 窗口分配受 maxReturnBytes 限制（不 OOM、truncated）", async () => {
    const LONG = join(ROOT, "src", "long-line.txt")
    // 第 0 行 = 1 MiB 单行（带行尾，使窗口可定位且超返回预算）。
    writeFileSync(LONG, "x".repeat(MIB) + "\ny\n", "utf-8")
    const reader = new BoundedFileReader()
    const result = await reader.readLineWindow(LONG, 0, 1, { maxReturnBytes: 256 * 1024 })
    expect(result.truncated).toBe(true)
    expect(result.text.length).toBeLessThanOrEqual(256 * 1024)
    expect(result.text.startsWith("x")).toBe(true)
  })

  test("P1-6: validateOpen 拒绝 → AUTHORITY_REJECTED（readFile）", async () => {
    const reader = new BoundedFileReader()
    let caught: unknown
    try {
      await reader.readFile(join(ROOT, "src", "small.txt"), {
        validateOpen: () => "SYMLINK_READ_ESCAPE: test rejection",
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(FileReadError)
    expect((caught as FileReadError).code).toBe("AUTHORITY_REJECTED")
  })

  test("P1-6: validateOpen 拒绝 → AUTHORITY_REJECTED（readRange / readLineWindow / readSync）", async () => {
    const reader = new BoundedFileReader()
    const reject = () => "SYMLINK_READ_ESCAPE: test rejection"
    for (const attempt of [
      () => reader.readRange(join(ROOT, "src", "small.txt"), 0, 16, { validateOpen: reject }),
      () => reader.readLineWindow(join(ROOT, "src", "small.txt"), 0, 1, { validateOpen: reject }),
      () => Promise.resolve(reader.readSync(join(ROOT, "src", "small.txt"), 16, { validateOpenSync: reject })),
    ]) {
      let caught: unknown
      try {
        await attempt()
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(FileReadError)
      expect((caught as FileReadError).code).toBe("AUTHORITY_REJECTED")
    }
  })
})

describe("IC01-R3 readAtomicSnapshot —— 选区与全文件哈希来自同一已验证 fd", () => {
  test("range 选区 + 全文件哈希：内容与哈希一致（同一次快照）", async () => {
    const p = join(ROOT, "snap-1.txt")
    writeFileSync(p, "alpha\nbeta\ngamma\n", "utf-8")
    const reader = new BoundedFileReader()
    const snap = await reader.readAtomicSnapshot(p, { start: 0, length: 5 })
    expect(snap.buffer.toString("utf-8")).toBe("alpha")
    expect(snap.byteCount).toBe(5)
    expect(snap.wholeFileSha256).toBe(fingerprintContent("alpha\nbeta\ngamma\n").sha256)
    expect(snap.hashBudgeted).toBe(true)
    expect(snap.totalBytes).toBe(17)
    expect(snap.truncated).toBe(false)
  })

  test("full 快照：内容覆盖全文件时直接从缓冲区哈希（同一 fd，无二次读取）", async () => {
    const p = join(ROOT, "snap-2.txt")
    writeFileSync(p, "whole content line\n", "utf-8")
    const reader = new BoundedFileReader()
    const snap = await reader.readAtomicSnapshot(p, null)
    expect(snap.buffer.toString("utf-8")).toBe("whole content line\n")
    expect(snap.wholeFileSha256).toBe(fingerprintContent("whole content line\n").sha256)
  })

  test("两次路径切换攻击：validateOpen 只调用一次；路径切换 + 同大小改写 → SNAPSHOT_CHANGED fail closed（绝不二次按路径 open、绝不返回混版成功结果）", async () => {
    const p = join(ROOT, "snap-swap.txt")
    writeFileSync(p, "original-content-1\nsecond line\n", "utf-8")
    const reader = new BoundedFileReader()
    let validateCalls = 0
    let caught: unknown
    try {
      await reader.readAtomicSnapshot(p, { start: 0, length: 9 }, {
        validateOpen: async () => {
          validateCalls++
          // 模拟 check→read 窗口内的路径切换：rename 原文件并在原路径放新文件；
          // 同时对被打开文件（已改名）做同大小原地改写 —— 身份变化必须被
          // 最终 fstat（bigint mtimeNs/ctimeNs）捕获 → fail closed。
          renameSync(p, p + ".moved")
          writeFileSync(p, "REPLACED-CONTENT-XXX", "utf-8")
          await rewriteUntilTick(p + ".moved", "R".repeat(31)) // 同大小 31
          return null
        },
      })
    } catch (e) {
      caught = e
    }
    // 单次 open —— 若实现先读后关、再按路径二次 open 做哈希，validateCalls=2。
    expect(validateCalls).toBe(1)
    expect(caught).toBeInstanceOf(FileReadError)
    expect((caught as FileReadError).code).toBe("SNAPSHOT_CHANGED")
  })

  test("同 fd 哈希期间 append（size 增长）→ SNAPSHOT_CHANGED fail closed", async () => {
    const p = join(ROOT, "snap-append.txt")
    writeFileSync(p, "v1-content", "utf-8")
    const reader = new BoundedFileReader()
    let caught: unknown
    try {
      await reader.readAtomicSnapshot(p, null, {
        validateOpen: async () => {
          appendFileSync(p, "-appended")
          return null
        },
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(FileReadError)
    expect((caught as FileReadError).code).toBe("SNAPSHOT_CHANGED")
  })

  test("同 fd 哈希期间 truncate（同一 fd 截断）→ SNAPSHOT_CHANGED fail closed", async () => {
    const p = join(ROOT, "snap-truncate.txt")
    writeFileSync(p, "v1-content-nine", "utf-8")
    const reader = new BoundedFileReader()
    let caught: unknown
    try {
      await reader.readAtomicSnapshot(p, null, {
        validateOpen: async (fd) => {
          truncateSync(p, 4)
          return null
        },
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(FileReadError)
    expect((caught as FileReadError).code).toBe("SNAPSHOT_CHANGED")
  })

  test("同 fd 哈希期间 replace（路径被换 + 同大小改写）→ SNAPSHOT_CHANGED fail closed（IC01-R4：身份变化必须 fail closed）", async () => {
    const p = join(ROOT, "snap-replace.txt")
    writeFileSync(p, "ORIGINAL-VERSION", "utf-8")
    const reader = new BoundedFileReader()
    let caught: unknown
    try {
      await reader.readAtomicSnapshot(p, { start: 0, length: 8 }, {
        validateOpen: async () => {
          // 在 validateOpen 之后、读取之前替换路径（fd 保持原 inode），并对
          // 被打开文件做同大小原地改写 —— 最终 fstat 必须 fail closed。
          renameSync(p, p + ".old")
          writeFileSync(p, "NEW-VERSION-AT-PATH", "utf-8")
          await rewriteUntilTick(p + ".old", "X".repeat(16)) // 同大小 16
          return null
        },
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(FileReadError)
    expect((caught as FileReadError).code).toBe("SNAPSHOT_CHANGED")
  })

  test("全文件哈希预算不足（size > budget）→ hashBudgeted=false，且不做无意义读取", async () => {
    const p = join(ROOT, "snap-unbudgeted.txt")
    const fd = await open(p, "w")
    try {
      const head = Array.from({ length: 600 }, (_, i) => `hash head line ${i}`).join("\n") + "\n"
      await fd.write(head, 0, "utf-8")
      await fd.truncate(70 * 1024 * 1024)
    } finally {
      await fd.close()
    }
    const reader = new BoundedFileReader()
    const snap = await reader.readAtomicSnapshot(p, { start: 0, length: 10 })
    expect(snap.hashBudgeted).toBe(false)
    expect(snap.wholeFileSha256).toBe("")
    expect(snap.byteCount).toBe(0)
  })

  test("readLineWindow + wholeFileHashBudgetBytes：窗口与全文件哈希来自同一 fd", async () => {
    const p = join(ROOT, "snap-win.txt")
    writeFileSync(p, "a\nb\nc\n", "utf-8")
    const reader = new BoundedFileReader()
    let validateCalls = 0
    const result = await reader.readLineWindow(p, 0, 1, {
      wholeFileHashBudgetBytes: 1024 * 1024,
      validateOpen: async () => {
        validateCalls++
        return null
      },
    })
    expect(validateCalls).toBe(1)
    expect(result.text).toBe("a")
    expect(result.wholeFileSha256).toBe(fingerprintContent("a\nb\nc\n").sha256)
    expect(result.wholeFileHashBudgeted).toBe(true)
  })

  test("readLineWindow 哈希期间 append → SNAPSHOT_CHANGED fail closed", async () => {
    const p = join(ROOT, "snap-win-append.txt")
    writeFileSync(p, "line one\nline two\n", "utf-8")
    const reader = new BoundedFileReader()
    let caught: unknown
    try {
      await reader.readLineWindow(p, 0, 1, {
        wholeFileHashBudgetBytes: 1024 * 1024,
        validateOpen: async () => {
          appendFileSync(p, "extra line\n")
          return null
        },
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(FileReadError)
    expect((caught as FileReadError).code).toBe("SNAPSHOT_CHANGED")
  })

  test("readLineWindow wholeFileHashBudgetBytes 不足 → wholeFileHashBudgeted=false（绝不退化为窗口哈希）", async () => {
    const reader = new BoundedFileReader()
    const result = await reader.readLineWindow(SPARSE, 0, 1, { wholeFileHashBudgetBytes: 1024 * 1024 })
    expect(result.wholeFileHashBudgeted).toBe(false)
    expect(result.wholeFileSha256).toBeNull()
    expect(result.text.length).toBeGreaterThan(0)
  })
})

describe("IC01-R4 单遍快照 —— 同一批 chunk 消费（READ_OFFSET_DUPLICATION / POST_HASH_WINDOW_REREAD / SAME_SIZE / EXACT_BUDGET）", () => {
  test("READ_OFFSET_DUPLICATION=0：expectedHash 路径每个文件字节最多读取一次（单遍单调连续，无 offset 0 重读）", async () => {
    const p = join(ROOT, "r4-single-pass.txt")
    const size = 100 * 1024
    const content = "head-line\n" + "z".repeat(size - 10)
    writeFileSync(p, content, "utf-8")
    const reader = new BoundedFileReader({ chunkSize: 4096 })
    const reads: Array<{ position: number; bytesRead: number }> = []
    const snap = await reader.readAtomicSnapshot(p, { start: 5000, length: 300 }, {
      onChunk: (position, bytesRead) => {
        reads.push({ position, bytesRead })
      },
    })
    // 单遍：chunk 数 == ceil(size/chunkSize)；读取区间 [position, position+bytesRead)
    // 单调、连续、无重叠、总覆盖恰好一次（直接断言真实 read position）。
    expect(reads.length).toBe(Math.ceil(size / 4096))
    for (let i = 0; i < reads.length; i++) {
      expect(reads[i]!.position).toBe(i * 4096)
    }
    const covered = reads.reduce((n, r) => n + r.bytesRead, 0)
    expect(covered).toBe(size)
    expect(reads[0]!.position).toBe(0)
    // 选区内容与哈希来自同一遍字节流。
    expect(snap.buffer.toString("utf-8")).toBe(content.slice(5000, 5300))
    expect(snap.wholeFileSha256).toBe(fingerprintContent(content).sha256)
    expect(snap.hashBudgeted).toBe(true)
  })

  test("POST_HASH_WINDOW_REREAD=0：readLineWindow 行定位/窗口捕获/哈希消费同一批 chunk（含 expectedHash 续扫）", async () => {
    const p = join(ROOT, "r4-win-pass.txt")
    const size = 120 * 1024
    const content = "first line\nsecond line\n" + "m".repeat(size - 23)
    writeFileSync(p, content, "utf-8")
    const reader = new BoundedFileReader({ chunkSize: 4096 })
    const reads: Array<{ position: number; bytesRead: number }> = []
    const result = await reader.readLineWindow(p, 0, 2, {
      wholeFileHashBudgetBytes: 1024 * 1024,
      onChunk: (position, bytesRead) => {
        reads.push({ position, bytesRead })
      },
    })
    // 扫描 + 哈希续扫 = 恰好 ceil(size/chunkSize) 个连续 chunk —— 无窗口重读
    // （直接断言真实 read position 单调连续、总覆盖恰好一次）。
    expect(reads.length).toBe(Math.ceil(content.length / 4096))
    for (let i = 0; i < reads.length; i++) {
      expect(reads[i]!.position).toBe(i * 4096)
    }
    const covered = reads.reduce((n, r) => n + r.bytesRead, 0)
    expect(covered).toBe(content.length)
    expect(result.text).toBe("first line\nsecond line")
    expect(result.wholeFileSha256).toBe(fingerprintContent(content).sha256)
    expect(result.wholeFileHashBudgeted).toBe(true)

    // 无 expectedHash：窗口在首个 chunk 内定位并捕获 —— 只有 1 次读取。
    const reads2: Array<{ position: number; bytesRead: number }> = []
    const r2 = await reader.readLineWindow(p, 0, 2, {
      onChunk: (position, bytesRead) => {
        reads2.push({ position, bytesRead })
      },
    })
    expect(reads2.length).toBe(1)
    expect(reads2[0]!.position).toBe(0)
    // 窗口在首个 chunk 内定位完成 → 单次读取即结束（读取区间 = [0, chunkSize)）。
    expect(reads2[0]!.bytesRead).toBe(4096)
    expect(r2.text).toBe("first line\nsecond line")
  })

  test("SAME_SIZE_INPLACE_MUTATION：扫描期间同大小原地改写 → SNAPSHOT_CHANGED（readAtomicSnapshot）", async () => {
    const p = join(ROOT, "r4-same-size-snap.txt")
    const content = "A".repeat(50 * 1024)
    writeFileSync(p, content, "utf-8")
    const reader = new BoundedFileReader({ chunkSize: 4096 })
    let caught: unknown
    try {
      await reader.readAtomicSnapshot(p, { start: 0, length: 100 }, {
        onChunk: async (_position, _bytes, index) => {
          if (index === 2) {
            // 同 inode、同大小、内容不同的原地改写（mtime 前进到新 jiffy）。
            await rewriteUntilTick(p, "B".repeat(content.length))
          }
        },
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(FileReadError)
    expect((caught as FileReadError).code).toBe("SNAPSHOT_CHANGED")
  })

  test("SAME_SIZE_INPLACE_MUTATION：扫描期间同大小原地改写 → SNAPSHOT_CHANGED（readLineWindow + expectedHash 续扫）", async () => {
    const p = join(ROOT, "r4-same-size-win.txt")
    const content = "L0\n" + "A".repeat(50 * 1024)
    writeFileSync(p, content, "utf-8")
    const reader = new BoundedFileReader({ chunkSize: 4096 })
    let caught: unknown
    try {
      await reader.readLineWindow(p, 0, 1, {
        wholeFileHashBudgetBytes: 1024 * 1024,
        onChunk: async (_position, _bytes, index) => {
          if (index === 2) {
            await rewriteUntilTick(p, "L0\n" + "B".repeat(50 * 1024))
          }
        },
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(FileReadError)
    expect((caught as FileReadError).code).toBe("SNAPSHOT_CHANGED")
  })

  test("EXACT_BUDGET_EMPTY_SELECTION=0：文件大小恰好等于哈希预算 → 正常返回请求选区（非空）", async () => {
    const p = join(ROOT, "r4-exact-budget.txt")
    const size = 1024 * 1024 // 1 MiB
    const fd = await open(p, "w")
    try {
      await fd.write("exact-budget-head\n", 0, "utf-8")
      await fd.truncate(size)
    } finally {
      await fd.close()
    }
    const reader = new BoundedFileReader({ operationBudgetBytes: size }) // 预算 == 文件大小
    const snap = await reader.readAtomicSnapshot(p, { start: 0, length: 18 })
    expect(snap.hashBudgeted).toBe(true)
    expect(snap.byteCount).toBe(18)
    expect(snap.buffer.toString("utf-8")).toBe("exact-budget-head\n")
    expect(snap.wholeFileSha256.length).toBe(64)
    // full 快照同样正常返回（内容覆盖预算内全部字节）。
    const full = await reader.readAtomicSnapshot(p, null)
    expect(full.hashBudgeted).toBe(true)
    expect(full.byteCount).toBe(size)
  })
})

// ── IC01-R5: 跨 chunk 行窗口错行封闭（tail 绑定行号）+ exact scan budget ──

describe("IC01-R5 跨 chunk 行窗口 —— tail 绑定行号，绝不包含 startLine 之前的字节", () => {
  /** 表驱动：构造 prelude 行 + 长前一行（跨 chunk）+ TARGET 行，断言窗口
   *  精确返回 TARGET（旧实现会把前一行前缀错误提升进目标窗口）。 */
  const cases = [
    { name: "前一行跨 3 chunk，目标行跨 2 chunk 有尾换行", chunkSize: 8, prevLen: 17, target: "TARGET-LINE-AB", tail: "\n", extra: "" },
    { name: "同 chunk 双换行（前一行换行 + 目标行换行）", chunkSize: 16, prevLen: 9, target: "QQQ", tail: "\n", extra: "next\n" },
    { name: "chunkSize=1 逐字节扫描", chunkSize: 1, prevLen: 5, target: "XY", tail: "\n", extra: "z\n" },
    { name: "chunkSize=2", chunkSize: 2, prevLen: 7, target: "TARGET", tail: "\n", extra: "after\n" },
    { name: "chunkSize=16 前一行恰整 chunk", chunkSize: 16, prevLen: 16, target: "T", tail: "\n", extra: "e\n" },
    { name: "目标行无尾随换行（EOF）", chunkSize: 8, prevLen: 13, target: "LAST-NO-NEWLINE", tail: "", extra: "" },
    { name: "前一行与目标行均为单字节", chunkSize: 2, prevLen: 1, target: "K", tail: "\n", extra: "m\n" },
  ]

  for (const c of cases) {
    test(`chunkSize=${c.chunkSize} — ${c.name}：TARGET 精确返回，不含上一行`, async () => {
      const p = join(ROOT, `r5-window-c${c.chunkSize}-${c.prevLen}.txt`)
      // 前一行内容用可辨识字符（P），目标行用可辨识字符（T…）—— 断言绝不混入。
      const prevLine = "P".repeat(c.prevLen)
      const content = "prelude-line\n" + prevLine + "\n" + c.target + c.tail + c.extra
      writeFileSync(p, content, "utf-8")
      const reader = new BoundedFileReader({ chunkSize: c.chunkSize })
      const startLine = 1 // 0-based：prelude 行后 → 前一行（P 行）
      const result = await reader.readLineWindow(p, startLine + 1, 1, { scanToEof: true })
      expect(result.text).toBe(c.target)
      expect(result.text).not.toContain("P")
      expect(result.text).not.toContain("prelude")
      // 多行窗口：从 P 行开始 count=2 → P 行 + TARGET（含中间换行，无前导）。
      const two = await reader.readLineWindow(p, startLine, 2, { scanToEof: true })
      expect(two.text).toBe(prevLine + "\n" + c.target)
      // startLine=0 的窗口（prelude 行）不受影响。
      const first = await reader.readLineWindow(p, 0, 1, { scanToEof: true })
      expect(first.text).toBe("prelude-line")
    })
  }

  test("R5 审计复现：前一行跨 chunk，下一 chunk 同时含前一行换行 + 目标行换行 → 窗口精确 = 目标行", async () => {
    const p = join(ROOT, "r5-audit-repro.txt")
    // chunk 0 = 16 字节全 P（前一行前缀，无换行）；chunk 1 同时含前一行换行
    // （offset 4）与目标行换行（offset 8）—— 旧实现把 16 字节 P 提升进窗口。
    const content = "P".repeat(16) + "PPPP\n" + "QQQ\n" + "rest\n"
    writeFileSync(p, content, "utf-8")
    const reader = new BoundedFileReader({ chunkSize: 16 })
    const result = await reader.readLineWindow(p, 1, 1, { scanToEof: true })
    expect(result.text).toBe("QQQ")
    expect(result.text).not.toContain("P")
  })

  test("窗口边界稳健性：startLine 深、count 大、无尾换行 EOF 组合", async () => {
    const p = join(ROOT, "r5-deep-start.txt")
    const lines = ["l0", "l1", "l2", "l3", "l4", "l5-no-newline"]
    const content = lines.join("\n")
    writeFileSync(p, content, "utf-8")
    const reader = new BoundedFileReader({ chunkSize: 2 })
    const result = await reader.readLineWindow(p, 4, 2, { scanToEof: true })
    // startLine=4（l4）、count=2 → l4 + l5（无尾换行，EOF 行）。
    expect(result.text).toBe("l4\nl5-no-newline")
    expect(result.linesCount).toBe(2)
    expect(result.totalLines).toBe(6)
    expect(result.scannedToEof).toBe(true)
    // offset-only（count=Infinity）：从 l3 到 EOF。
    const inf = await reader.readLineWindow(p, 3, Number.POSITIVE_INFINITY, { scanToEof: true })
    expect(inf.text).toBe("l3\nl4\nl5-no-newline")
    expect(inf.truncated).toBe(false)
  })
})

describe("IC01-R5 exact scan budget —— EOF 优先于预算，预算恰等于文件大小 = 完整成功", () => {
  let p = ""
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "orcana-ic01-r5-budget-"))
    p = join(dir, "r5-scan-budget.txt")
    writeFileSync(p, "a\nb\n", "utf-8") // fileSize = 4
  })

  test("scanBudget === fileSize：count=Infinity → scannedToEof=true, truncated=false, 完整窗口", async () => {
    const reader = new BoundedFileReader()
    const result = await reader.readLineWindow(p, 0, Number.POSITIVE_INFINITY, { scanBudgetBytes: 4 })
    expect(result.text).toBe("a\nb\n")
    expect(result.scannedToEof).toBe(true)
    expect(result.truncated).toBe(false)
    expect(result.linesCount).toBe(2)
    expect(result.totalLines).toBe(3) // 旧 split 语义：["a","b",""]
  })

  test("scanBudget === fileSize：有限 count=1 → 窗口完整成功", async () => {
    const reader = new BoundedFileReader()
    const result = await reader.readLineWindow(p, 0, 1, { scanBudgetBytes: 4 })
    expect(result.text).toBe("a")
    expect(result.scannedToEof).toBe(true)
    expect(result.truncated).toBe(false)
  })

  test("scanBudget === fileSize：scanToEof=true → 完整成功", async () => {
    const reader = new BoundedFileReader()
    const result = await reader.readLineWindow(p, 0, 1, { scanBudgetBytes: 4, scanToEof: true })
    expect(result.text).toBe("a")
    expect(result.scannedToEof).toBe(true)
    expect(result.truncated).toBe(false)
    expect(result.totalLines).toBe(3) // 旧 split 语义（含尾空行）
  })

  test("scanBudget === fileSize：expectedHash 开启 → 完整哈希 + 完整窗口", async () => {
    const reader = new BoundedFileReader()
    const result = await reader.readLineWindow(p, 0, Number.POSITIVE_INFINITY, {
      scanBudgetBytes: 4,
      wholeFileHashBudgetBytes: 1024,
    })
    expect(result.text).toBe("a\nb\n")
    expect(result.scannedToEof).toBe(true)
    expect(result.truncated).toBe(false)
    expect(result.wholeFileHashBudgeted).toBe(true)
    expect(result.wholeFileSha256).toBe(fingerprintContent("a\nb\n").sha256)
  })

  test("scanBudget === fileSize - 1：诚实截断（scannedToEof=false, truncated=true）", async () => {
    const reader = new BoundedFileReader()
    const result = await reader.readLineWindow(p, 0, Number.POSITIVE_INFINITY, { scanBudgetBytes: 3 })
    expect(result.text).toBe("a\nb") // 只扫到预算处
    expect(result.scannedToEof).toBe(false)
    expect(result.truncated).toBe(true)
    expect(result.totalLines).toBeNull()
  })

  test("scanBudget === fileSize - 1 且窗口完整：仍诚实标记 truncated（扫描未完成）", async () => {
    const reader = new BoundedFileReader()
    const result = await reader.readLineWindow(p, 0, 1, { scanBudgetBytes: 3 })
    expect(result.text).toBe("a")
    expect(result.scannedToEof).toBe(false)
    expect(result.truncated).toBe(true)
  })

  test("返回长度只由捕获范围/windowEnd/maxReturnBytes 决定（maxReturn 截断窗口）", async () => {
    const reader = new BoundedFileReader()
    const result = await reader.readLineWindow(p, 0, Number.POSITIVE_INFINITY, {
      scanBudgetBytes: 4,
      maxReturnBytes: 2,
    })
    expect(result.text).toBe("a\n")
    expect(result.truncated).toBe(true)
  })
})

// ── IC01-R6: onChunk Promise 合约（readFile / readRange 必须 await）──

describe("IC01-R6 onChunk Promise 合约 —— readFile/readRange await 语义", () => {
  let fixtureDir = ""
  let bigP = ""
  let chunkCount = 0
  beforeAll(async () => {
    // IC01-R7 测试卫生：保存临时目录路径，afterAll 精确 rmSync（不清理其他 /tmp）。
    fixtureDir = mkdtempSync(join(tmpdir(), "orcana-ic01-r6-onchunk-"))
    bigP = join(fixtureDir, "big.txt")
    // 约 5 KiB fixture（5018 字节 → 5 个 1024 字节 chunk —— 不是 >8 KiB）。
    writeFileSync(bigP, "line-0\n" + "m".repeat(5000) + "\nline-last\n", "utf-8")
    chunkCount = Math.ceil((await stat(bigP)).size / 1024)
  })
  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true })
  })

  test("readFile：onChunk 返回延迟 Promise → 下一 chunk 在 resolve 前不开始", async () => {
    const reader = new BoundedFileReader({ chunkSize: 1024 })
    const order: string[] = []
    await reader.readFile(bigP, {
      onChunk: async (_position, _bytes, index) => {
        order.push(`start${index}`)
        await new Promise(resolve => setTimeout(resolve, 3))
        order.push(`end${index}`)
      },
    })
    // 真实 chunk 数：每 chunk 恰好一个 start+end 事件对（不能用事件数当 chunk 数）。
    expect(order.length).toBe(2 * chunkCount)
    expect(chunkCount).toBe(5)
    // 每个 start 必须紧跟在前一个 end 之后（串行 await，绝不并发重叠）。
    for (let i = 1; i < order.length; i++) {
      if (order[i]!.startsWith("start")) {
        expect(order[i - 1]!.startsWith("end")).toBe(true)
      }
    }
    expect(order[0]).toBe("start1")
    expect(order[order.length - 1]!.startsWith("end")).toBe(true)
  })

  test("readFile：onChunk rejection 由 readFile 正常 reject（无 unhandled rejection）", async () => {
    const reader = new BoundedFileReader({ chunkSize: 1024 })
    let calls = 0
    await expect(
      reader.readFile(bigP, {
        onChunk: async () => {
          calls++
          throw new Error("boom-readfile")
        },
      }),
    ).rejects.toThrow("boom-readfile")
    expect(calls).toBe(1) // 第一个 chunk 即拒绝
  })

  test("readRange：onChunk rejection 由 readRange 正常 reject", async () => {
    const reader = new BoundedFileReader({ chunkSize: 1024 })
    await expect(
      reader.readRange(bigP, 0, 5000, {
        onChunk: async () => {
          throw new Error("boom-readrange")
        },
      }),
    ).rejects.toThrow("boom-readrange")
  })

  test("readFile/readRange：await 后 position/bytesRead/chunkIndex 仍精确单调连续", async () => {
    const reader = new BoundedFileReader({ chunkSize: 1024 })
    const fileSize = (await stat(bigP)).size
    const reads: Array<{ position: number; bytesRead: number; index: number }> = []
    await reader.readFile(bigP, {
      onChunk: async (position, bytesRead, index) => {
        await new Promise(resolve => setTimeout(resolve, 1))
        reads.push({ position, bytesRead, index })
      },
    })
    expect(reads.length).toBe(Math.ceil(fileSize / 1024))
    let covered = 0
    for (let i = 0; i < reads.length; i++) {
      expect(reads[i]!.position).toBe(i * 1024)
      expect(reads[i]!.index).toBe(i + 1)
      covered += reads[i]!.bytesRead
    }
    expect(covered).toBe(fileSize)

    const rangeReads: Array<{ position: number; bytesRead: number }> = []
    await reader.readRange(bigP, 1000, 3000, {
      onChunk: async (position, bytesRead) => {
        await new Promise(resolve => setTimeout(resolve, 1))
        rangeReads.push({ position, bytesRead })
      },
    })
    // range：从 offset 1000 起连续 3000 字节（3 个 1024 chunk）。
    expect(rangeReads.length).toBe(3)
    for (let i = 0; i < rangeReads.length; i++) {
      expect(rangeReads[i]!.position).toBe(1000 + i * 1024)
    }
    const rangeCovered = rangeReads.reduce((n, r) => n + r.bytesRead, 0)
    expect(rangeCovered).toBe(3000)
  })
})

// ── IC01-R7: onChunk 后 abort 复核 —— 最后 chunk 期间 abort 也必须 ABORTED ──

describe("IC01-R7 chunk abort 闭合 —— 每个 onChunk 后立即复核 abort", () => {
  let fixtureDir = ""
  let smallP = "" // 单 chunk（< 1024 字节）
  let multiP = "" // 3 个 1024 字节 chunk
  beforeAll(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), "orcana-ic01-r7-abort-"))
    smallP = join(fixtureDir, "small.txt")
    writeFileSync(smallP, "single-chunk-content\n", "utf-8")
    multiP = join(fixtureDir, "multi.txt")
    writeFileSync(multiP, "head-line\n" + "m".repeat(2048) + "\ntail-line\n", "utf-8") // 3 chunk
  })
  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true })
  })

  test("1. readFile 单 chunk：onChunk 内 abort 后 resolve → ABORTED（不得 success）", async () => {
    const reader = new BoundedFileReader({ chunkSize: 1024 })
    const controller = new AbortController()
    await expect(
      reader.readFile(smallP, {
        signal: controller.signal,
        onChunk: async () => {
          controller.abort()
        },
      }),
    ).rejects.toMatchObject({ code: "ABORTED" })
  })

  test("2. readRange 单 chunk：onChunk 内 abort 后 resolve → ABORTED", async () => {
    const reader = new BoundedFileReader({ chunkSize: 1024 })
    const controller = new AbortController()
    await expect(
      reader.readRange(smallP, 0, 500, {
        signal: controller.signal,
        onChunk: async () => {
          controller.abort()
        },
      }),
    ).rejects.toMatchObject({ code: "ABORTED" })
  })

  test("3. readAtomicSnapshot 单 chunk：onChunk 内 abort 后 resolve → ABORTED", async () => {
    const reader = new BoundedFileReader({ chunkSize: 1024 })
    const controller = new AbortController()
    await expect(
      reader.readAtomicSnapshot(smallP, { start: 0, length: 10 }, {
        signal: controller.signal,
        onChunk: async () => {
          controller.abort()
        },
      }),
    ).rejects.toMatchObject({ code: "ABORTED" })
  })

  test("4. readLineWindow 窗口立即结束：scanToEof=false 窗口在首 chunk 找到；onChunk abort 后即将 break → ABORTED", async () => {
    const reader = new BoundedFileReader({ chunkSize: 1024 })
    const controller = new AbortController()
    await expect(
      reader.readLineWindow(smallP, 0, 1, {
        signal: controller.signal,
        scanToEof: false,
        onChunk: async () => {
          controller.abort()
        },
      }),
    ).rejects.toMatchObject({ code: "ABORTED" })
  })

  test("5. readLineWindow expectedHash 续扫：窗口首 chunk 找到，哈希至最后 chunk；最后 chunk onChunk abort → ABORTED", async () => {
    const reader = new BoundedFileReader({ chunkSize: 1024 })
    const controller = new AbortController()
    await expect(
      reader.readLineWindow(multiP, 0, 1, {
        signal: controller.signal,
        wholeFileHashBudgetBytes: 1024 * 1024,
        onChunk: async (_position, _bytes, index) => {
          // index 1 = 主扫描首 chunk（窗口找到后 break）；2、3 = 续扫；3 = 最后 chunk。
          if (index === 3) controller.abort()
        },
      }),
    ).rejects.toMatchObject({ code: "ABORTED" })
  })

  test("无 onChunk：读取前 abort → 返回前复核 → ABORTED（await undefined 后复核路径）", async () => {
    const reader = new BoundedFileReader({ chunkSize: 1024 })
    const controller = new AbortController()
    controller.abort()
    await expect(
      reader.readFile(smallP, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "ABORTED" })
  })
})
