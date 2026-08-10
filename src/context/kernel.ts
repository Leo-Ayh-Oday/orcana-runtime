import { existsSync, readdirSync, statSync } from "node:fs"
import { basename, join, relative } from "node:path"
import { createHash } from "node:crypto"
import { BoundedFileReader } from "../runtime/io/bounded-file-reader"

/** IC01: 有界读取器（readKernelFile 同步管线用）—— 完整 read 后 slice 是
 *  UNBOUNDED_RUNTIME_FILE_READ = 0 禁止的模式；此处只按需读 head/tail。 */
const KERNEL_READER = new BoundedFileReader()

export interface ContextKernel {
  text: string
  hash: string
  estimatedTokens: number
  sections: string[]
  /** K39: per-file read notes for files that exceeded the read budget
   *  (head + tail preserved, middle omitted). Absent = nothing truncated. */
  fileNotes?: Array<{ file: string; truncated: boolean; totalChars: number }>
}

const ROOT_FILES = ["AGENTS.md", "CLAUDE.md", "OPENWOLF.md", "README.md", "package.json", "tsconfig.json"]
const SKIP_DIRS = new Set([".git", ".codegraph", "node_modules", "dist", "coverage", ".next", ".orcana"])

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12)
}

/** K39: read a kernel file without silently dropping its tail.
 *
 *  Files within budget are read in full. Long files use the K14 head+tail
 *  strategy: keep the head (rules context) AND the tail (the end of the file
 *  is no longer lost), mark the omission inline, and report truncation +
 *  total length in the kernel meta (`fileNotes`).
 *
 *  IC01: 有界读取 —— 大文件只按需读取 head/tail 窗口（BoundedFileReader），
 *  绝不 readFileSync 完整读入后再 slice（UNBOUNDED_RUNTIME_FILE_READ = 0）。
 *  字节级截断点可能落在 UTF-8 多字节字符中间（marker 已声明截断）。
 */
function readKernelFile(path: string, maxChars: number): { content: string; truncated: boolean; totalChars: number } {
  if (!existsSync(path)) return { content: "", truncated: false, totalChars: 0 }
  try {
    const info = KERNEL_READER.statSync(path)
    if (!info.isRegular) return { content: "", truncated: false, totalChars: 0 }
    const totalChars = info.size
    if (totalChars <= maxChars) {
      return { content: KERNEL_READER.readSync(path, maxChars).toString("utf-8"), truncated: false, totalChars }
    }
    const head = Math.floor(maxChars * 0.6)
    const marker = `\n[context kernel: middle ${totalChars - maxChars} chars omitted; file total ${totalChars} chars - head+tail preserved]\n`
    const tail = maxChars - head - marker.length
    if (tail < 64) {
      // Degenerate budget: the tail cannot fit — keep a full head but mark
      // the omission explicitly so truncation is never silent.
      const headText = KERNEL_READER.readSync(path, Math.max(64, maxChars)).toString("utf-8")
      return { content: headText + marker, truncated: true, totalChars }
    }
    const headText = KERNEL_READER.readSync(path, head).toString("utf-8")
    const tailText = KERNEL_READER.readSyncRange(path, totalChars - tail, tail).toString("utf-8")
    return {
      content: headText + marker + tailText,
      truncated: true,
      totalChars,
    }
  } catch {
    return { content: "", truncated: false, totalChars: 0 }
  }
}

function collectSourceSkeleton(root: string, maxFiles = 80): string[] {
  const files: string[] = []
  const walk = (dir: string) => {
    if (files.length >= maxFiles) return
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(full)
        continue
      }
      if (/\.(ts|tsx|js|jsx)$/.test(name)) files.push(relative(root, full).replace(/\\/g, "/"))
      if (files.length >= maxFiles) return
    }
  }
  for (const dir of ["src", "tests"]) {
    const full = join(root, dir)
    if (existsSync(full)) walk(full)
  }
  return files
}

export function buildContextKernel(projectRoot = process.cwd()): ContextKernel {
  const sections: string[] = []
  const fileNotes: NonNullable<ContextKernel["fileNotes"]> = []
  const chunks: string[] = [
    "## Target Project Context",
    "This describes the user's current working directory, not the Orcana runtime.",
    "Assistant runtime artifacts such as .orcana/ are intentionally excluded.",
  ]

  for (const file of ROOT_FILES) {
    const read = readKernelFile(join(projectRoot, file), file.endsWith(".json") ? 4000 : 3000)
    if (!read.content.trim()) continue
    sections.push(file)
    if (read.truncated) fileNotes.push({ file, truncated: true, totalChars: read.totalChars })
    chunks.push(`\n### ${file}\n${read.content.trim()}`)
  }

  const skeleton = collectSourceSkeleton(projectRoot)
  if (skeleton.length) {
    sections.push("source-skeleton")
    chunks.push(`\n### source-skeleton\n${skeleton.join("\n")}`)
  }

  const text = chunks.join("\n").trim()
  return {
    text,
    hash: hash(text),
    estimatedTokens: Math.ceil(text.length / 3),
    sections,
    fileNotes: fileNotes.length ? fileNotes : undefined,
  }
}
