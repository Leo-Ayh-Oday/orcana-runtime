/** Git tools — status, diff, log, blame, show, add, commit. */

import { execFileSync } from "node:child_process"
import type { ToolDef, ToolResult } from "./registry"
import { Result } from "./registry"

/**
 * Run git with an argv array (never a shell string) so model- or repository-
 * controlled arguments (commit message, ref, path) cannot inject shell commands.
 */
function runGit(args: string[], timeout = 30): { code: number; stdout: string; stderr: string } {
  try {
    const out = execFileSync("git", args, { timeout: timeout * 1000, encoding: "utf-8" })
    return { code: 0, stdout: out, stderr: "" }
  } catch (e: any) {
    return { code: e.status ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "git command failed" }
  }
}

/** Cap output with a truncation note — model knows it got snipped and can request more. */
function capOutput(raw: string, label: string, maxChars: number): string {
  if (raw.length <= maxChars) return raw
  const head = raw.slice(0, maxChars)
  const skipped = raw.length - maxChars
  return `${head}\n\n… [${label}: ${skipped} chars trimmed — use 'path' param or re-run with line range to narrow scope]`
}

async function git_status(): Promise<ToolResult> {
  const { code, stdout, stderr } = runGit(["status", "--short"])
  if (code !== 0) return Result.fail(stderr)
  if (!stdout.trim()) return Result.ok("Clean working tree")
  return Result.ok(capOutput(stdout, "git status", 6000))
}

async function git_diff(params: Record<string, unknown>): Promise<ToolResult> {
  const args = ["diff"]
  if (params.staged) args.push("--staged")
  if (params.path) args.push("--", String(params.path))
  const { code, stdout, stderr } = runGit(args)
  if (code !== 0) return Result.fail(stderr)
  if (!stdout.trim()) return Result.ok("No changes")
  return Result.ok(capOutput(stdout, "git diff", 12000))
}

async function git_log(params: Record<string, unknown>): Promise<ToolResult> {
  const n = Number(params.n ?? 10)
  const args = ["log", `-${n}`, "--oneline", "--decorate"]
  if (params.path) args.push("--", String(params.path))
  const { code, stdout, stderr } = runGit(args)
  if (code !== 0) return Result.fail(stderr)
  return Result.ok(capOutput(stdout, "git log", 6000))
}

async function git_blame(params: Record<string, unknown>): Promise<ToolResult> {
  const path = String(params.path ?? "")
  const args = ["blame", "--date=short"]
  if (params.line_start && params.line_end) {
    args.push("-L", `${params.line_start},${params.line_end}`)
  }
  args.push("--", path)
  const { code, stdout, stderr } = runGit(args)
  if (code !== 0) return Result.fail(stderr)
  return Result.ok(capOutput(stdout, "git blame", 6000))
}

async function git_show(params: Record<string, unknown>): Promise<ToolResult> {
  const ref = String(params.ref ?? "HEAD")
  const args = ["show", ref]
  if (params.path) args.push("--", String(params.path))
  const { code, stdout, stderr } = runGit(args)
  if (code !== 0) return Result.fail(stderr)
  if (!stdout.trim()) return Result.ok("No changes in this commit")
  return Result.ok(capOutput(stdout, "git show", 12000))
}

async function git_add(params: Record<string, unknown>): Promise<ToolResult> {
  if (params.all === true) {
    const { code, stdout, stderr } = runGit(["add", "-A"])
    if (code !== 0) return Result.fail(stderr)
    return Result.ok(stdout.trim() ? stdout : "Staged all changes")
  }

  const path = String(params.path ?? "")
  if (!path) return Result.fail("Either 'path' or 'all=true' is required")
  const { code, stdout, stderr } = runGit(["add", "--", path])
  if (code !== 0) return Result.fail(stderr)
  return Result.ok(stdout.trim() ? stdout : `Staged: ${path}`)
}

async function git_commit(params: Record<string, unknown>): Promise<ToolResult> {
  const message = String(params.message ?? "").trim()
  if (!message) return Result.fail("Commit message is required (use 'message' param)")

  // Optional: stage all tracked files before committing
  if (params.all === true) {
    const addResult = runGit(["add", "-A"])
    if (addResult.code !== 0) return Result.fail(addResult.stderr)
  }

  const { code, stdout, stderr } = runGit(["commit", "-m", message])
  if (code !== 0) return Result.fail(stderr)
  return Result.ok(stdout.trim() || "Committed")
}

export const GIT_STATUS: ToolDef = {
  name: "git_status",
  description: "Show git working tree status (short format)",
  isReadonly: true,
  category: "git" as const,
  inputSchema: { type: "object", properties: {} },
  execute: git_status,
}

export const GIT_DIFF: ToolDef = {
  name: "git_diff",
  description: "Show git diff (unstaged by default, set staged=true for staged)",
  isReadonly: true,
  category: "git" as const,
  inputSchema: {
    type: "object",
    properties: {
      staged: { type: "boolean", description: "Show staged changes" },
      path: { type: "string", description: "Filter to file" },
    },
  },
  execute: git_diff,
}

export const GIT_LOG: ToolDef = {
  name: "git_log",
  description: "Show recent git commits (oneline format)",
  isReadonly: true,
  category: "git" as const,
  inputSchema: {
    type: "object",
    properties: {
      n: { type: "integer", description: "Number of commits (default 10)" },
      path: { type: "string", description: "Filter to file" },
    },
  },
  execute: git_log,
}

export const GIT_BLAME: ToolDef = {
  name: "git_blame",
  description: "Show who last modified each line",
  isReadonly: true,
  category: "git" as const,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      line_start: { type: "integer" },
      line_end: { type: "integer" },
    },
    required: ["path"],
  },
  execute: git_blame,
}

export const GIT_SHOW: ToolDef = {
  name: "git_show",
  description: "Show changes in a specific commit (default HEAD)",
  isReadonly: true,
  category: "git" as const,
  inputSchema: {
    type: "object",
    properties: {
      ref: { type: "string", description: "Commit hash, branch, or tag (default HEAD)" },
      path: { type: "string", description: "Filter to specific file" },
    },
  },
  execute: git_show,
}

export const GIT_ADD: ToolDef = {
  name: "git_add",
  description: "Stage files for commit. Use all=true to stage everything, or specify a path.",
  isReadonly: false,
  isConcurrencySafe: false,
  category: "git" as const,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File or directory to stage" },
      all: { type: "boolean", description: "Stage all changes (git add -A)" },
    },
  },
  execute: git_add,
}

export const GIT_COMMIT: ToolDef = {
  name: "git_commit",
  description:
    "Commit staged changes with a message.\n" +
    "\n" +
    "## 参数\n" +
    "- message: 提交信息（必需）\n" +
    "- all: 设为 true 会先执行 git add -A 暂存所有变更再提交\n" +
    "\n" +
    "## 注意\n" +
    "- 不会自动 push，需要用户手动推送\n" +
    "- 提交前应先用 git_status 检查变更、git_diff 检查内容",
  isReadonly: false,
  isConcurrencySafe: false,
  category: "git" as const,
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "Commit message (required)" },
      all: { type: "boolean", description: "Stage all changes before committing (git add -A)" },
    },
    required: ["message"],
  },
  execute: git_commit,
}

export const GIT_TOOLS: ToolDef[] = [GIT_STATUS, GIT_DIFF, GIT_LOG, GIT_BLAME, GIT_SHOW, GIT_ADD, GIT_COMMIT]
