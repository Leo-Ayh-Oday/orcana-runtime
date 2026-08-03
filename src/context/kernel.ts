import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { basename, join, relative } from "node:path"
import { createHash } from "node:crypto"

export interface ContextKernel {
  text: string
  hash: string
  estimatedTokens: number
  sections: string[]
}

const ROOT_FILES = ["AGENTS.md", "CLAUDE.md", "OPENWOLF.md", "README.md", "package.json", "tsconfig.json"]
const SKIP_DIRS = new Set([".git", ".codegraph", "node_modules", "dist", "coverage", ".next", ".orcana"])

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12)
}

function readSmallFile(path: string, maxChars: number): string {
  if (!existsSync(path)) return ""
  try {
    return readFileSync(path, "utf-8").slice(0, maxChars)
  } catch {
    return ""
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
  const chunks: string[] = [
    "## Target Project Context",
    "This describes the user's current working directory, not the Orcana runtime.",
    "Assistant runtime artifacts such as .orcana/ are intentionally excluded.",
  ]

  for (const file of ROOT_FILES) {
    const content = readSmallFile(join(projectRoot, file), file.endsWith(".json") ? 4000 : 3000)
    if (!content.trim()) continue
    sections.push(file)
    chunks.push(`\n### ${file}\n${content.trim()}`)
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
  }
}
