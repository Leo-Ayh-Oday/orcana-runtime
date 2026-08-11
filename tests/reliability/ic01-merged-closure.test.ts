/** IC01-R2 merged closure: 已合入 main 的 IC01 遗留安全问题回归测试。
 *
 *  覆盖（对应审计发现）：
 *    1. ContextMap authority 绕过 —— README/src 外逃 symlink、secret alias、
 *       多文件共享累计预算、bounded top-K。
 *    2. hardlink secret 绕过 —— public.txt -> .env 拒绝；grant 精确匹配。
 *    3. fd 校验 fail-open —— readlink 失败 / fd 失效 / 目标删除 / dev-inode
 *       替换 → fail closed。
 *    4. EOF 无换行回归 —— "alpha\nomega" 第二行返回 omega；单行无尾换行。
 *    5. async readRange 上限 —— maxFileBytes + operationBudgetBytes 双重限制。
 *    6. expectedHash 全文件语义 —— byte_range/line window 不得使用选区哈希；
 *       选区外修改 → STALE_FILE；超出全文件哈希预算 → 结构化拒绝。
 *    7. 物理根一致性 —— projectRoot 同物理目录 alias 完整支持，无
 *       "漂移通过又报 OUTSIDE_WORKSPACE_READ" 矛盾。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { open } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { buildTool } from "../../src/tools/registry"
import { READ_FILE } from "../../src/tools/file"
import {
  createRuntimeExecutionContext,
  runWithRuntimeExecutionContext,
  setWorkspaceIoAuthority,
} from "../../src/runtime/execution-context"
import {
  createWorkspaceIoAuthority,
  checkWorkspaceBaseDrift,
  checkSecretRead,
  enforceWorkspaceRead,
  validateOpenFileCanonical,
  validateOpenFileCanonicalSync,
  type WorkspaceIoAuthority,
} from "../../src/runtime/io/workspace-io-authority"
import { BoundedFileReader } from "../../src/runtime/io/bounded-file-reader"
import {
  ContextMapReadSession,
  buildContextMap,
  hybridLocate,
  loadProjectConstitution,
} from "../../src/context/context-map"
import { fingerprintContent } from "../../src/file-state"
import type { ToolExecutionContext } from "../../src/tools/registry"

const MIB = 1024 * 1024

let ROOT = ""
let OUTSIDE = ""
let PROJECT_LINK = ""
let SPARSE_1G = ""

beforeAll(async () => {
  ROOT = mkdtempSync(join(tmpdir(), "orcana-ic01-r2-"))
  OUTSIDE = mkdtempSync(join(tmpdir(), "orcana-ic01-r2-out-"))
  mkdirSync(join(ROOT, "src", "agent"), { recursive: true })
  mkdirSync(join(OUTSIDE, "src"), { recursive: true })
  writeFileSync(join(ROOT, "src", "a.txt"), "WORKSPACE-CONTENT\n", "utf-8")
  writeFileSync(join(ROOT, "src", "agent", "mod.ts"), "export const marker = 'inside'\n", "utf-8")
  writeFileSync(join(OUTSIDE, "src", "outside-mod.ts"), "export const outsideMarker = 'outside-secret'\n", "utf-8")
  writeFileSync(join(OUTSIDE, "outside.txt"), "OUTSIDE-SECRET-CONTENT", "utf-8")
  writeFileSync(join(ROOT, ".env"), "TOKEN=hardlink-secret", "utf-8")
  writeFileSync(join(ROOT, ".env.example"), "TOKEN=example", "utf-8")
  writeFileSync(join(ROOT, ".env.example.production"), "TOKEN=prod-secret", "utf-8")
  writeFileSync(join(ROOT, ".env.example.secret"), "TOKEN=secret-variant", "utf-8")
  writeFileSync(join(ROOT, "no-eol.txt"), "alpha\nomega", "utf-8")
  writeFileSync(join(ROOT, "single.txt"), "no-newline-content", "utf-8")
  writeFileSync(join(ROOT, "win.txt"), "alpha\nbeta\ngamma\n", "utf-8")
  // 1 GiB sparse 文件（头部 35 KiB 文本行，其余空洞）。
  SPARSE_1G = join(ROOT, "sparse-1gib.txt")
  const fd = await open(SPARSE_1G, "w")
  try {
    const head = Array.from({ length: 1200 }, (_, i) => `sparse line ${i} 0123456789`).join("\n") + "\n"
    await fd.write(head, 0, "utf-8")
    await fd.truncate(1024 * MIB)
  } finally {
    await fd.close()
  }
  PROJECT_LINK = join(tmpdir(), `orcana-ic01-r2-link-${process.pid}`)
  try {
    symlinkSync(ROOT, PROJECT_LINK)
  } catch {
    // exists
  }
})

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
  rmSync(OUTSIDE, { recursive: true, force: true })
  rmSync(PROJECT_LINK, { recursive: true, force: true })
})

function authorityFor(root = ROOT, grants: string[] = []): WorkspaceIoAuthority {
  return createWorkspaceIoAuthority(root, { secretGrants: grants })
}

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    projectRoot: ROOT,
    abortSignal: new AbortController().signal,
    ...overrides,
  } as ToolExecutionContext
}

async function withAuthority<T>(authority: WorkspaceIoAuthority, callback: () => Promise<T>): Promise<T> {
  const ctx = createRuntimeExecutionContext()
  return runWithRuntimeExecutionContext(ctx, async () => {
    setWorkspaceIoAuthority(authority)
    return await callback()
  })
}

const read = buildTool(READ_FILE)

// ── 4. EOF 无尾换行 ──

describe("IC01-R2 #4 EOF 无尾换行回归", () => {
  test('readLineWindow("alpha\\nomega") 第二行返回 omega（无尾换行末行）', async () => {
    const reader = new BoundedFileReader()
    const result = await reader.readLineWindow(join(ROOT, "no-eol.txt"), 1, 1)
    expect(result.text).toBe("omega")
    expect(result.linesCount).toBe(1)
    expect(result.totalLines).toBe(2)
    expect(result.scannedToEof).toBe(true)
    expect(result.truncated).toBe(false)
  })

  test("单行无尾换行文件请求第一行正确返回", async () => {
    const reader = new BoundedFileReader()
    const result = await reader.readLineWindow(join(ROOT, "single.txt"), 0, 1)
    expect(result.text).toBe("no-newline-content")
    expect(result.linesCount).toBe(1)
    expect(result.totalLines).toBe(1)
  })

  test("readLineWindow 第一行（有换行）语义不变", async () => {
    const reader = new BoundedFileReader()
    const result = await reader.readLineWindow(join(ROOT, "no-eol.txt"), 0, 1)
    expect(result.text).toBe("alpha")
    expect(result.linesCount).toBe(1)
  })

  test("工具级：offset/limit 读取无尾换行末行（含 authority + fd 校验）", async () => {
    await withAuthority(authorityFor(ROOT), async () => {
      const result = await read.execute({ path: "no-eol.txt", offset: 1, limit: 1 }, makeContext())
      expect(result.success).toBe(true)
      expect(result.content).toContain("omega")
      expect(result.content).not.toContain("alpha\nomega")
    })
  })

  test("offset 越界（行号超出文件）→ 空窗口，不扫描到预算之外", async () => {
    const reader = new BoundedFileReader()
    const result = await reader.readLineWindow(join(ROOT, "no-eol.txt"), 99, 1)
    expect(result.text).toBe("")
    expect(result.linesCount).toBe(0)
  })
})

// ── 5. async readRange 上限 ──

describe("IC01-R2 #5 async readRange 双预算上限", () => {
  test("maxFileBytes=16 MiB 时 range 请求 64 MiB → 只读 16 MiB（truncated）", async () => {
    const reader = new BoundedFileReader() // 默认 maxFileBytes=16 MiB, budget=64 MiB
    const result = await reader.readRange(SPARSE_1G, 0, 64 * MIB)
    expect(result.truncated).toBe(true)
    expect(result.byteCount).toBe(16 * MIB)
    expect(result.buffer.length).toBe(16 * MIB)
  })

  test("operationBudgetBytes=8 MiB + maxFileBytes=16 MiB → 只读 8 MiB", async () => {
    const reader = new BoundedFileReader({ operationBudgetBytes: 8 * MIB })
    const result = await reader.readRange(SPARSE_1G, 0, 64 * MIB)
    expect(result.truncated).toBe(true)
    expect(result.byteCount).toBe(8 * MIB)
    expect(result.buffer.length).toBe(8 * MIB)
  })

  test("requested 与文件剩余长度同时受限（offset 深处短 range）", async () => {
    const reader = new BoundedFileReader()
    const result = await reader.readRange(SPARSE_1G, 1024 * MIB - 100, 4096)
    expect(result.byteCount).toBe(100)
    expect(result.truncated).toBe(true)
  })
})

// ── 17 MiB 以上单行 + 6. expectedHash 全文件语义 ──

describe("IC01-R2 #6 expectedHash 全文件 SHA-256 语义", () => {
  test("byte_range + 全文件 expectedHash：未变化文件通过；选区外修改 → STALE_FILE", async () => {
    const p = join(ROOT, "win.txt")
    const whole = fingerprintContent("alpha\nbeta\ngamma\n").sha256
    await withAuthority(authorityFor(ROOT), async () => {
      const ok = await read.execute(
        { path: "win.txt", selector: { kind: "byte_range", start: 0, length: 5 }, expectedHash: whole },
        makeContext(),
      )
      expect(ok.success).toBe(true)
      expect(ok.content).toBe("alpha")
      // 选区外内容变化 → 旧全文件 hash 必须 STALE_FILE（选区哈希不得冒充）。
      writeFileSync(p, "alpha\nbeta\nGAMMA\n", "utf-8")
      const stale = await read.execute(
        { path: "win.txt", selector: { kind: "byte_range", start: 0, length: 5 }, expectedHash: whole },
        makeContext(),
      )
      expect(stale.success).toBe(false)
      expect(stale.content).toContain("STALE_FILE")
    })
  })

  test("line window + 全文件 expectedHash：选区外修改触发 STALE_FILE", async () => {
    const p = join(ROOT, "win2.txt")
    writeFileSync(p, "line zero\nline one\nline two\n", "utf-8")
    const whole = fingerprintContent("line zero\nline one\nline two\n").sha256
    await withAuthority(authorityFor(ROOT), async () => {
      const ok = await read.execute(
        { path: "win2.txt", offset: 0, limit: 1, expectedHash: whole },
        makeContext(),
      )
      expect(ok.success).toBe(true)
      expect(ok.content).toContain("line zero")
      // 窗口外（第 3 行）变化 → STALE_FILE。
      writeFileSync(p, "line zero\nline one\nline TWO\n", "utf-8")
      const stale = await read.execute(
        { path: "win2.txt", offset: 0, limit: 1, expectedHash: whole },
        makeContext(),
      )
      expect(stale.success).toBe(false)
      expect(stale.content).toContain("STALE_FILE")
    })
  })

  test("17 MiB 以上单行：默认 16 MiB 限制下不返回整行、不超限分配", async () => {
    const p = join(ROOT, "huge-line.txt")
    const line = "H".repeat(17 * MIB)
    writeFileSync(p, line + "\nend\n", "utf-8")
    const reader = new BoundedFileReader()
    const before = process.memoryUsage().rss
    const result = await reader.readLineWindow(p, 0, 1)
    const after = process.memoryUsage().rss
    expect(result.text.length).toBeLessThanOrEqual(16 * MIB)
    expect(result.text.startsWith("H")).toBe(true)
    expect(result.truncated).toBe(true)
    expect(after - before).toBeLessThan(64 * MIB)
  })

  test("大文件 line window + expectedHash：使用全文件哈希，窗口哈希绝不冒充", async () => {
    const p = join(ROOT, "big-win.txt")
    const content = "first line content\n" + "x".repeat(17 * MIB) + "\nTRAILER_LINE\n"
    writeFileSync(p, content, "utf-8")
    const whole = fingerprintContent(content).sha256
    await withAuthority(authorityFor(ROOT), async () => {
      // 17 MiB 文件（> 16 MiB maxFileBytes，≤ 64 MiB 哈希预算）：
      // 全文件哈希可计算 → 窗口读取 + expectedHash 必须通过。
      const ok = await read.execute(
        { path: "big-win.txt", offset: 0, limit: 1, expectedHash: whole },
        makeContext(),
      )
      expect(ok.success).toBe(true)
      expect(ok.content).toContain("first line content")
      // 窗口外（TRAILER）变化 → 旧 hash 必须 STALE_FILE —— 若用窗口哈希
      // 冒充，这里会错误通过。
      const changed = "first line content\n" + "x".repeat(17 * MIB) + "\nTRAILER_CHANGED\n"
      writeFileSync(p, changed, "utf-8")
      const stale = await read.execute(
        { path: "big-win.txt", offset: 0, limit: 1, expectedHash: whole },
        makeContext(),
      )
      expect(stale.success).toBe(false)
      expect(stale.content).toContain("STALE_FILE")
    })
  })

  test("超出全文件哈希预算（> 64 MiB）→ 结构化拒绝，不得退化成窗口哈希", async () => {
    const p = join(ROOT, "giant-hash.txt")
    const fd = await open(p, "w")
    try {
      // 头部 8 KiB 内填充文本行（避开二进制嗅探），其余为空洞。
      const head = Array.from({ length: 600 }, (_, i) => `hash head line ${i}`).join("\n") + "\n"
      await fd.write(head, 0, "utf-8")
      await fd.truncate(70 * MIB)
    } finally {
      await fd.close()
    }
    await withAuthority(authorityFor(ROOT), async () => {
      const result = await read.execute(
        { path: "giant-hash.txt", offset: 0, limit: 1, expectedHash: "deadbeef".repeat(8) },
        makeContext(),
      )
      expect(result.success).toBe(false)
      expect(result.content).toContain("WHOLE_FILE_HASH_UNBUDGETED")
      expect(result.content).not.toContain("STALE_FILE")
    })
  })
})

// ── 2. hardlink secret 绕过 + .env.example 精确放行 ──

describe("IC01-R2 #2 hardlink secret alias 与 .env.example 精确语义", () => {
  test("public.txt 与 .env 同一 hardlink inode → 读取 public.txt 拒绝（SECRET_READ）", async () => {
    const publicPath = join(ROOT, "src", "public.txt")
    try {
      linkSync(join(ROOT, ".env"), publicPath)
    } catch {
      rmSync(publicPath, { force: true })
      linkSync(join(ROOT, ".env"), publicPath)
    }
    await withAuthority(authorityFor(ROOT), async () => {
      const result = await read.execute({ path: "src/public.txt" }, makeContext())
      expect(result.success).toBe(false)
      expect(result.metadata).toMatchObject({
        blocked: true,
        gate: "workspace_io",
        workspaceIo: { code: "SECRET_READ" },
      })
      // 直接读取 .env 本身同样拒绝（对照组）。
      const direct = await read.execute({ path: ".env" }, makeContext())
      expect(direct.success).toBe(false)
    })
  })

  test("post-open fd 校验同样拒绝 hardlink 秘密 inode", async () => {
    const fd = openSync(join(ROOT, "src", "public.txt"), "r")
    try {
      const ws = authorityFor(ROOT)
      const violation = await validateOpenFileCanonical(ws, join(ROOT, "src", "public.txt"), fd)
      expect(violation).not.toBeNull()
      expect(violation?.code).toBe("SECRET_READ")
    } finally {
      closeSync(fd)
    }
  })

  test("grant 只精确匹配 .env 的 canonical 路径；hardlink 别名 public.txt 仍拒绝", async () => {
    const ws = authorityFor(ROOT, [resolve(ROOT, ".env")])
    await withAuthority(ws, async () => {
      const direct = await read.execute({ path: ".env" }, makeContext())
      expect(direct.success).toBe(true)
      expect(direct.content).toContain("TOKEN=hardlink-secret")
      const alias = await read.execute({ path: "src/public.txt" }, makeContext())
      expect(alias.success).toBe(false)
      expect((alias.metadata?.workspaceIo as { code?: string } | undefined)?.code).toBe("SECRET_READ")
    })
  })

  test(".env.example 精确放行；.env.example.secret / .env.example.production 拒绝", async () => {
    await withAuthority(authorityFor(ROOT), async () => {
      const example = await read.execute({ path: ".env.example" }, makeContext())
      expect(example.success).toBe(true)
      expect(example.content).toContain("TOKEN=example")

      for (const file of [".env.example.secret", ".env.example.production"]) {
        const result = await read.execute({ path: file }, makeContext())
        expect(result.success).toBe(false)
        expect((result.metadata?.workspaceIo as { code?: string } | undefined)?.code).toBe("SECRET_READ")
      }
    })
  })

  test("checkSecretRead 单元级：后缀变体命中规则", () => {
    const ws = authorityFor(ROOT)
    expect(checkSecretRead(ws, resolve(ROOT, ".env.example"))).toBeNull()
    expect(checkSecretRead(ws, resolve(ROOT, ".env.example.secret"))?.code).toBe("SECRET_READ")
    expect(checkSecretRead(ws, resolve(ROOT, ".env.example.production"))?.code).toBe("SECRET_READ")
  })
})

// ── 3. fd 校验 fail closed ──

describe("IC01-R2 #3 fd canonical 校验 fail closed", () => {
  test("readlink 失败（fd 已关闭）→ 拒绝，不静默放行（async + sync）", async () => {
    const ws = authorityFor(ROOT)
    const fd = openSync(join(ROOT, "src", "a.txt"), "r")
    closeSync(fd)
    const asyncViolation = await validateOpenFileCanonical(ws, join(ROOT, "src", "a.txt"), fd)
    expect(asyncViolation).not.toBeNull()
    expect(asyncViolation?.code).toBe("SYMLINK_READ_ESCAPE")
    const syncViolation = validateOpenFileCanonicalSync(ws, join(ROOT, "src", "a.txt"), fd)
    expect(syncViolation).not.toBeNull()
    expect(syncViolation?.code).toBe("SYMLINK_READ_ESCAPE")
  })

  test("无效 fd → 拒绝", async () => {
    const ws = authorityFor(ROOT)
    const violation = await validateOpenFileCanonical(ws, join(ROOT, "src", "a.txt"), 999_999)
    expect(violation).not.toBeNull()
  })

  test("open 目标被 unlink（deleted）→ 拒绝", async () => {
    const p = join(ROOT, "toctou-delete.txt")
    writeFileSync(p, "v1", "utf-8")
    const fd = openSync(p, "r")
    try {
      rmSync(p, { force: true })
      const ws = authorityFor(ROOT)
      const violation = await validateOpenFileCanonical(ws, p, fd)
      expect(violation).not.toBeNull()
      expect(violation?.code).toBe("SYMLINK_READ_ESCAPE")
      const syncViolation = validateOpenFileCanonicalSync(ws, p, fd)
      expect(syncViolation).not.toBeNull()
    } finally {
      closeSync(fd)
    }
  })

  test("open 目标被 rename 且路径被重建 → fd 仍指向原 in-root 文件，不误拒；读取始终来自已验证句柄", async () => {
    const p = join(ROOT, "toctou-rename.txt")
    writeFileSync(p, "v1-original", "utf-8")
    const fd = openSync(p, "r")
    try {
      // rename 后 fd 的 dentry 跟随到新路径（仍在根内）；重建的路径是
      // 另一个 inode —— 但读取始终来自已验证句柄，绝不按路径重开。
      renameSync(p, p + ".old")
      writeFileSync(p, "v2-replacement", "utf-8")
      const ws = authorityFor(ROOT)
      const violation = await validateOpenFileCanonical(ws, p, fd)
      // fd 目标仍为根内普通文件（canonical = p.old，dev/inode 一致）→ 不误拒。
      expect(violation).toBeNull()
      // 句柄内容 = 打开时的原文件（v1），绝不读取重建后的路径内容。
      const buf = Buffer.alloc(16)
      const { readSync } = await import("node:fs")
      const n = readSync(fd, buf, 0, 16, 0)
      expect(buf.subarray(0, n).toString("utf-8")).toBe("v1-original")
    } finally {
      closeSync(fd)
    }
  })

  test("O_NOFOLLOW：final-component symlink 不再被 open（ELOOP fail closed）", async () => {
    const p = join(ROOT, "src", "final-link.txt")
    try {
      symlinkSync(join(ROOT, "src", "a.txt"), p)
    } catch {
      // exists
    }
    // 无 authority：策略层不拦（realpath 在根内），但安全 open 必须拒绝。
    const result = await read.execute({ path: "src/final-link.txt" }, makeContext())
    expect(result.success).toBe(false)
  })
})

// ── 1. ContextMap authority 绕过 ──

describe("IC01-R2 #1 ContextMap authority 绕过", () => {
  test("README symlink 外逃 → 拒绝读取，不进入 importantFiles/notes", async () => {
    const root = mkdtempSync(join(tmpdir(), "orcana-ic01-r2-cm-escape-"))
    try {
      writeFileSync(join(root, "package.json"), '{"name":"x"}', "utf-8")
      symlinkSync(join(OUTSIDE, "outside.txt"), join(root, "README.md"))
      const ws = createWorkspaceIoAuthority(root)
      const constitution = loadProjectConstitution(root, { workspace: ws })
      expect(constitution.importantFiles).not.toContain("README.md")
      const all = constitution.architectureNotes
        .concat(constitution.codingRules, constitution.forbiddenActions, constitution.knownPitfalls)
        .join("\n")
      expect(all).not.toContain("OUTSIDE-SECRET-CONTENT")
      expect(ws).toBeDefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("README symlink → workspace 内 .env（secret alias）→ 拒绝", async () => {
    const root = mkdtempSync(join(tmpdir(), "orcana-ic01-r2-cm-secret-"))
    try {
      writeFileSync(join(root, "package.json"), '{"name":"x"}', "utf-8")
      writeFileSync(join(root, ".env"), "TOKEN=cm-secret", "utf-8")
      symlinkSync(join(root, ".env"), join(root, "README.md"))
      const ws = createWorkspaceIoAuthority(root)
      const constitution = loadProjectConstitution(root, { workspace: ws })
      expect(constitution.importantFiles).not.toContain("README.md")
      const all = constitution.architectureNotes.concat(constitution.codingRules).join("\n")
      expect(all).not.toContain("cm-secret")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("src 源文件 symlink 外逃 → 不进入定位结果", async () => {
    const root = mkdtempSync(join(tmpdir(), "orcana-ic01-r2-cm-src-"))
    try {
      mkdirSync(join(root, "src"), { recursive: true })
      writeFileSync(join(root, "package.json"), '{"name":"x"}', "utf-8")
      symlinkSync(join(OUTSIDE, "src", "outside-mod.ts"), join(root, "src", "evil.ts"))
      const ws = createWorkspaceIoAuthority(root)
      const located = hybridLocate(root, { userRequest: "outsideMarker" }, { workspace: ws })
      expect(located.primaryFiles).not.toContain("src/evil.ts")
      expect(located.relevantSymbols).not.toContain("outsideMarker")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("src 目录为外逃 symlink → 目录枚举拒绝（无列表泄漏）", async () => {
    const root = mkdtempSync(join(tmpdir(), "orcana-ic01-r2-cm-dir-"))
    try {
      writeFileSync(join(root, "package.json"), '{"name":"x"}', "utf-8")
      symlinkSync(join(OUTSIDE, "src"), join(root, "src"))
      const ws = createWorkspaceIoAuthority(root)
      const located = hybridLocate(root, { userRequest: "outsideMarker" }, { workspace: ws })
      const all = [...located.primaryFiles, ...located.secondaryFiles]
      expect(all).not.toContain("outside-mod.ts")
      expect(all.length).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("多文件共享累计预算：bytesRead ≤ budget，预算外文件不入选", async () => {
    const root = mkdtempSync(join(tmpdir(), "orcana-ic01-r2-cm-budget-"))
    try {
      mkdirSync(join(root, "src"), { recursive: true })
      writeFileSync(join(root, "package.json"), '{"name":"x"}', "utf-8")
      const budgetBytes = 2 * MIB
      const fileSize = 800 * 1024
      for (let i = 0; i < 5; i++) {
        writeFileSync(join(root, "src", `f${i}.ts`), `budgetmarker f${i}\n` + "y".repeat(fileSize), "utf-8")
      }
      const ws = createWorkspaceIoAuthority(root)
      const session = new ContextMapReadSession({ workspace: ws, budgetBytes })
      const located = hybridLocate(root, { userRequest: "budgetmarker", maxFiles: 12 }, { session })
      expect(session.bytesRead).toBeLessThanOrEqual(budgetBytes)
      const all = [...located.primaryFiles, ...located.secondaryFiles]
      // 2 MiB 预算下最多完整读 2 个 800 KiB 文件 + 第 3 个的部分前缀；
      // 第 4/5 个文件必须被预算排除（独特内容不得出现）。
      expect(all.some(f => f === "src/f4.ts")).toBe(false)
      expect(all.some(f => f === "src/f3.ts")).toBe(false)
      expect(all.length).toBeLessThan(5)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("bounded top-K：候选超过 K 时只保留 K 个（未入选文本不长期保留）", async () => {
    const root = mkdtempSync(join(tmpdir(), "orcana-ic01-r2-cm-topk-"))
    try {
      mkdirSync(join(root, "src"), { recursive: true })
      writeFileSync(join(root, "package.json"), '{"name":"x"}', "utf-8")
      for (let i = 0; i < 20; i++) {
        writeFileSync(join(root, "src", `k${i}.ts`), `topkmarker file ${i}\n` + "z".repeat(64 * 1024), "utf-8")
      }
      const ws = createWorkspaceIoAuthority(root)
      const located = hybridLocate(root, { userRequest: "topkmarker", maxFiles: 4 }, { workspace: ws })
      const all = [...located.primaryFiles, ...located.secondaryFiles]
      expect(all.length).toBeLessThanOrEqual(4)
      expect(all.length).toBeGreaterThan(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("整次 buildContextMap 共享预算（session 贯穿四阶段）", async () => {
    const root = mkdtempSync(join(tmpdir(), "orcana-ic01-r2-cm-full-"))
    try {
      mkdirSync(join(root, "src"), { recursive: true })
      writeFileSync(join(root, "package.json"), '{"name":"x"}', "utf-8")
      writeFileSync(join(root, "src", "m.ts"), "sharedmarker export const m = 1\n", "utf-8")
      const ws = createWorkspaceIoAuthority(root)
      const session = new ContextMapReadSession({ workspace: ws, budgetBytes: 256 * 1024 })
      const map = buildContextMap(root, { taskId: "t", userRequest: "sharedmarker" }, { session })
      expect(map.id).toMatch(/^ctx-[a-f0-9]{12}$/)
      expect(session.bytesRead).toBeLessThanOrEqual(256 * 1024)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── 7. projectRoot 物理别名一致性 ──

describe("IC01-R2 #7 projectRoot 物理别名一致性", () => {
  test("漂移检查通过（alias 与 readRoot 同物理目录）", () => {
    const ws = authorityFor(ROOT)
    expect(checkWorkspaceBaseDrift(ws, PROJECT_LINK)).toBeNull()
  })

  test("alias projectRoot：既有文件正常读取，绝不报 OUTSIDE_WORKSPACE_READ", async () => {
    await withAuthority(authorityFor(ROOT), async () => {
      const result = await read.execute(
        { path: "src/a.txt" },
        makeContext({ projectRoot: PROJECT_LINK }),
      )
      expect(result.success).toBe(true)
      expect(result.content).toContain("WORKSPACE-CONTENT")
    })
  })

  test("alias projectRoot + 绝对 canonical 路径读取通过", async () => {
    await withAuthority(authorityFor(ROOT), async () => {
      const result = await read.execute(
        { path: join(ROOT, "src", "a.txt") },
        makeContext({ projectRoot: PROJECT_LINK }),
      )
      expect(result.success).toBe(true)
    })
  })

  test("alias projectRoot：不存在的路径 → File not found（不是 OUTSIDE_WORKSPACE_READ 矛盾）", async () => {
    await withAuthority(authorityFor(ROOT), async () => {
      const result = await read.execute(
        { path: "missing-file.txt" },
        makeContext({ projectRoot: PROJECT_LINK }),
      )
      expect(result.success).toBe(false)
      expect(result.content).toContain("File not found")
      const meta = result.metadata as { workspaceIo?: { code?: string } } | undefined
      expect(meta?.workspaceIo?.code).toBeUndefined()
    })
  })

  test("alias projectRoot：escape symlink 仍拒绝（SYMLINK_READ_ESCAPE）", async () => {
    const alias = join(ROOT, "src", "r2-alias-escape.txt")
    try {
      symlinkSync(join(OUTSIDE, "outside.txt"), alias)
    } catch {
      // exists
    }
    await withAuthority(authorityFor(ROOT), async () => {
      // readableRoots 放行 OUTSIDE → resolveToolPath 层放行；权威层（canonical
      // containment）必须仍拒绝 —— alias projectRoot 下同样成立。
      const result = await read.execute(
        { path: "src/r2-alias-escape.txt" },
        makeContext({ projectRoot: PROJECT_LINK, readableRoots: [OUTSIDE] }),
      )
      expect(result.success).toBe(false)
      expect((result.metadata?.workspaceIo as { code?: string } | undefined)?.code).toBe("SYMLINK_READ_ESCAPE")
    })
  })

  test("漂移不一致（不同物理目录）→ WORKSPACE_PATH_BASE_DRIFT（一致性拒绝路径）", async () => {
    const decoy = mkdtempSync(join(tmpdir(), "orcana-ic01-r2-decoy-"))
    try {
      const ws = authorityFor(ROOT)
      const drift = checkWorkspaceBaseDrift(ws, decoy)
      expect(drift?.code).toBe("WORKSPACE_PATH_BASE_DRIFT")
      await withAuthority(ws, async () => {
        const result = await read.execute({ path: "src/a.txt" }, makeContext({ projectRoot: decoy }))
        expect(result.success).toBe(false)
        expect((result.metadata?.workspaceIo as { code?: string } | undefined)?.code).toBe("WORKSPACE_PATH_BASE_DRIFT")
      })
    } finally {
      rmSync(decoy, { recursive: true, force: true })
    }
  })
})

// ── fixture 自检 ──

describe("IC01-R2 fixture 自检", () => {
  test("硬链接存在且同一 inode", () => {
    const st1 = statSync(join(ROOT, ".env"))
    const st2 = statSync(join(ROOT, "src", "public.txt"))
    expect(st1.dev).toBe(st2.dev)
    expect(st1.ino).toBe(st2.ino)
    expect(st1.nlink).toBeGreaterThanOrEqual(2)
  })

  test("1 GiB sparse 文件物理占用远小于逻辑大小", () => {
    const st = statSync(SPARSE_1G)
    expect(st.size).toBe(1024 * MIB)
    expect(st.blocks * 512).toBeLessThan(MIB)
  })

  test("README symlink 外逃 fixture 存在", () => {
    expect(existsSync(join(OUTSIDE, "outside.txt"))).toBe(true)
  })
})

// ── IC01-R3: hardlink 策略（无全树扫描，nlink>1 未授权 fail closed） ──

describe("IC01-R3 hardlink 策略 —— 未授权多链接文件 fail closed（无全树扫描）", () => {
  test("工作区外 id_ed25519 hardlink -> public.txt → 拒绝（外逃秘密无法用树扫描发现）", async () => {
    const outsideKey = join(OUTSIDE, "id_ed25519")
    writeFileSync(outsideKey, "OUTSIDE-PRIVATE-KEY-MATERIAL", "utf-8")
    const alias = join(ROOT, "src", "key-alias.txt")
    try {
      linkSync(outsideKey, alias)
    } catch {
      rmSync(alias, { force: true })
      linkSync(outsideKey, alias)
    }
    await withAuthority(authorityFor(ROOT), async () => {
      const result = await read.execute({ path: "src/key-alias.txt" }, makeContext())
      expect(result.success).toBe(false)
      expect(result.metadata).toMatchObject({
        blocked: true,
        gate: "workspace_io",
        workspaceIo: { code: "SECRET_READ" },
      })
    })
  })

  test("不可枚举目录内 .env hardlink -> public.txt → 拒绝（目录不可读也能 fail closed）", async () => {
    const locked = join(ROOT, "locked-dir")
    mkdirSync(locked, { recursive: true })
    writeFileSync(join(locked, ".env"), "LOCKED-ENV-SECRET", "utf-8")
    const alias = join(locked, "public.txt")
    try {
      linkSync(join(locked, ".env"), alias)
    } catch {
      rmSync(alias, { force: true })
      linkSync(join(locked, ".env"), alias)
    }
    // 目录改为执行-only（可 stat/open 路径，但 readdir 失败 —— 旧扫描方案
    // 无法枚举该目录，必然放行；新策略 nlink>1 未授权直接拒绝）。
    chmodSync(locked, 0o111)
    try {
      await withAuthority(authorityFor(ROOT), async () => {
        const result = await read.execute({ path: "locked-dir/public.txt" }, makeContext())
        expect(result.success).toBe(false)
        expect((result.metadata?.workspaceIo as { code?: string } | undefined)?.code).toBe("SECRET_READ")
      })
    } finally {
      chmodSync(locked, 0o755)
    }
  })

  test("多链接文件未获 grant 一律拒绝；grant 只放行被授权路径（不扩散到 hardlink 别名）", async () => {
    const a = join(ROOT, "hl-a.txt")
    const b = join(ROOT, "src", "hl-b.txt")
    writeFileSync(a, "SHARED-BODY", "utf-8")
    try {
      linkSync(a, b)
    } catch {
      rmSync(b, { force: true })
      linkSync(a, b)
    }
    const ws = authorityFor(ROOT, [resolve(ROOT, "hl-a.txt")])
    await withAuthority(ws, async () => {
      const granted = await read.execute({ path: "hl-a.txt" }, makeContext())
      expect(granted.success).toBe(true)
      expect(granted.content).toContain("SHARED-BODY")
      const alias = await read.execute({ path: "src/hl-b.txt" }, makeContext())
      expect(alias.success).toBe(false)
      expect((alias.metadata?.workspaceIo as { code?: string } | undefined)?.code).toBe("SECRET_READ")
    })
  })

  test("大量 hardlink 候选不会触发全树乘法扫描（O(1)/候选，无 readdir 遍历）", async () => {
    const root = mkdtempSync(join(tmpdir(), "orcana-ic01-r3-hl-"))
    try {
      mkdirSync(join(root, "src"), { recursive: true })
      const CANDIDATES = 400
      const FILLERS = 10_000
      // 候选：每个 hardlink 对（c{i}.ts / c{i}-alias.ts）。
      for (let i = 0; i < CANDIDATES; i++) {
        const orig = join(root, "src", `c${i}.ts`)
        writeFileSync(orig, `candidate ${i}\n`, "utf-8")
        linkSync(orig, join(root, "src", `c${i}-alias.ts`))
      }
      // 填充文件：旧"每次读取扫描全树"方案会反复 readdir 整个目录。
      for (let i = 0; i < FILLERS; i++) {
        writeFileSync(join(root, "src", `f${i}.ts`), "filler", "utf-8")
      }
      const ws = createWorkspaceIoAuthority(root)
      const started = Date.now()
      let rejected = 0
      for (let i = 0; i < CANDIDATES; i++) {
        const violation = enforceWorkspaceRead(ws, join(root, "src", `c${i}-alias.ts`), `c${i}-alias.ts`, root)
        expect(violation?.code).toBe("SECRET_READ")
        rejected++
      }
      const elapsed = Date.now() - started
      expect(rejected).toBe(CANDIDATES)
      // O(1)/候选：400 次策略检查必须在 2s 内完成（旧全树扫描方案为
      // 400 × 全树 readdir ≈ 数秒至数十秒）。
      expect(elapsed).toBeLessThan(2000)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("rename 竞态不能形成放行：读取前被换为多链接文件 → 拒绝（pre-open + post-open 双层）", async () => {
    const p = join(ROOT, "src", "race-target.txt")
    writeFileSync(p, "benign single-link", "utf-8")
    const src = join(ROOT, "src", "race-secret.txt")
    writeFileSync(src, "RACE-SECRET", "utf-8")
    await withAuthority(authorityFor(ROOT), async () => {
      // 读前把目标换成 secret 的 hardlink（nlink>1）→ 必须拒绝。
      const alias = join(ROOT, "src", "race-alias.txt")
      try {
        linkSync(src, alias)
      } catch {
        rmSync(alias, { force: true })
        linkSync(src, alias)
      }
      rmSync(p, { force: true })
      renameSync(alias, p)
      const result = await read.execute({ path: "src/race-target.txt" }, makeContext())
      expect(result.success).toBe(false)
      expect((result.metadata?.workspaceIo as { code?: string } | undefined)?.code).toBe("SECRET_READ")
    })
  })
})

// ── IC01-R3: ContextMap 无权威 fail closed + maxFiles 归一化 ──

describe("IC01-R3 ContextMap authority fail-closed 与 top-K 输入归一化", () => {
  test("无 ALS / 未注入 authority → 稳定拒绝：零读取、零内容泄漏（authorityMissing）", () => {
    const root = mkdtempSync(join(tmpdir(), "orcana-ic01-r3-noals-"))
    try {
      mkdirSync(join(root, "src"), { recursive: true })
      writeFileSync(join(root, "package.json"), '{"name":"x"}', "utf-8")
      writeFileSync(join(root, "src", "m.ts"), "SECRET-MARKER-CONTENT export const m = 1\n", "utf-8")
      const session = new ContextMapReadSession({})
      expect(session.authorityMissing).toBe(true)
      const constitution = loadProjectConstitution(root, { session })
      expect(constitution.importantFiles).toEqual([])
      const located = hybridLocate(root, { userRequest: "SECRET-MARKER-CONTENT" }, { session })
      expect(located.primaryFiles).toEqual([])
      expect(session.bytesRead).toBe(0)
      // 无显式会话的生产式调用同样 fail closed。
      const map = buildContextMap(root, { taskId: "t", userRequest: "SECRET-MARKER-CONTENT" })
      expect(map.locateResult.primaryFiles).toEqual([])
      expect(map.projectConstitution.importantFiles).toEqual([])
      const all = JSON.stringify(map)
      expect(all).not.toContain("SECRET-MARKER-CONTENT")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("production 路径（显式 authority）恶意 symlink + secret 拒绝", () => {
    const root = mkdtempSync(join(tmpdir(), "orcana-ic01-r3-prod-"))
    try {
      mkdirSync(join(root, "src"), { recursive: true })
      writeFileSync(join(root, "package.json"), '{"name":"x"}', "utf-8")
      writeFileSync(join(root, ".env"), "PROD-ENV-SECRET", "utf-8")
      writeFileSync(join(root, "src", "ok.ts"), "okmarker export const ok = 1\n", "utf-8")
      symlinkSync(join(root, ".env"), join(root, "README.md"))
      symlinkSync(join(OUTSIDE, "outside.txt"), join(root, "src", "evil.ts"))
      // prepare.ts 生产路径的等价调用：显式注入权威。
      const ws = createWorkspaceIoAuthority(root)
      const map = buildContextMap(root, { taskId: "t", userRequest: "okmarker" }, { workspace: ws })
      expect(map.projectConstitution.importantFiles).not.toContain("README.md")
      expect(map.locateResult.primaryFiles).not.toContain("src/evil.ts")
      const all = JSON.stringify(map)
      expect(all).not.toContain("PROD-ENV-SECRET")
      expect(all).not.toContain("OUTSIDE-SECRET-CONTENT")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("maxFiles=0 / -1 / NaN / Infinity → 归一化为安全空结果，且零扫描零读取", () => {
    const root = mkdtempSync(join(tmpdir(), "orcana-ic01-r3-maxk-"))
    try {
      mkdirSync(join(root, "src"), { recursive: true })
      writeFileSync(join(root, "package.json"), '{"name":"x"}', "utf-8")
      for (let i = 0; i < 5; i++) {
        writeFileSync(join(root, "src", `k${i}.ts`), `maxkmarker file ${i}\n`, "utf-8")
      }
      const ws = createWorkspaceIoAuthority(root)
      for (const bad of [0, -1, NaN, Number.POSITIVE_INFINITY]) {
        const session = new ContextMapReadSession({ workspace: ws })
        const located = hybridLocate(root, { userRequest: "maxkmarker", maxFiles: bad }, { session })
        expect(located.primaryFiles).toEqual([])
        expect(located.secondaryFiles).toEqual([])
        expect(located.definitions).toEqual([])
        expect(session.bytesRead).toBe(0)
        expect(session.budgetExhausted).toBe(false)
      }
      // undefined 保持默认 12；正常正数照常工作。
      const normal = hybridLocate(root, { userRequest: "maxkmarker", maxFiles: 2 }, { workspace: ws })
      expect(normal.primaryFiles.length).toBeGreaterThan(0)
      expect(normal.primaryFiles.length + normal.secondaryFiles.length).toBeLessThanOrEqual(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
