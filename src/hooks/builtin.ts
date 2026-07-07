/** Built-in hooks — write guard (before/after), journal veto, context monitor, api fallback. */

import type { LegacyHookHandler } from "./index"
import { JournalEngine } from "../agent/journal"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

/**
 * Guards against editing files that haven't been read first.
 * Ported from Oh-My-OpenAgent's Write-Existing-File-Guard.
 *
 * Split into two hooks:
 *   - writeGuardBefore (onToolBefore): checks read-set, warns or blocks
 *   - writeGuardAfter  (onToolAfter):  tracks successful reads into read-set
 *
 * Default mode is controlled by DEEPSEEK_WRITE_GUARD_MODE env var:
 *   - "warn" (default): warns but allows unread-file edits
 *   - "strict": blocks unread-file edits
 */
const writeGuardReadFiles = new Set<string>()

export type WriteGuardMode = "warn" | "strict"

export interface WriteGuardOptions {
  mode?: WriteGuardMode
  cwd?: string
  readFiles?: Set<string>
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/")
}

function canonicalPath(path: string, cwd?: string): string {
  return normalizePath(resolve(cwd ?? process.cwd(), path))
}

function writeGuardMode(options: WriteGuardOptions): WriteGuardMode {
  return options.mode ?? (process.env.DEEPSEEK_WRITE_GUARD_MODE === "strict" ? "strict" : "warn")
}

function writePaths(input: { tool?: string; params?: Record<string, unknown> }, cwd?: string): Array<{ display: string; canonical: string }> {
  const tool = input.tool ?? ""
  const params = input.params ?? {}

  if (tool === "multi_edit") {
    const edits = Array.isArray(params.edits) ? params.edits as Array<Record<string, unknown>> : []
    const paths = edits
      .map(edit => typeof edit.path === "string" ? edit.path : "")
      .filter(Boolean)
      .map(path => ({ display: normalizePath(path), canonical: canonicalPath(path, cwd) }))
    return [...new Map(paths.map(path => [path.canonical, path])).values()]
  }

  const rawPath = typeof params.path === "string" ? params.path : undefined
  if (!rawPath) return []
  const canonical = canonicalPath(rawPath, cwd)

  // write_file may create a new file; only existing targets require a prior read.
  if (tool === "write_file" && !existsSync(canonical)) return []

  if (tool === "write_file" || tool === "edit_file" || tool === "edit_fim") {
    return [{ display: normalizePath(rawPath), canonical }]
  }

  return []
}

/** Before-hook: checks if file has been read. In strict mode, blocks unread files. */
export function createWriteGuardBefore(options: WriteGuardOptions = {}): LegacyHookHandler {
  return (input) => {
    const mode = writeGuardMode(options)
    const readFiles = options.readFiles ?? writeGuardReadFiles
    const unreadPaths = writePaths(input, options.cwd)
      .filter(path => !readFiles.has(path.canonical))

    if (unreadPaths.length > 0) {
      const list = unreadPaths.map(path => path.display).join(", ")
      const message = `File ${list} hasn't been read yet — read it first before editing`
      if (mode === "strict") {
        return { blocked: true, warn: `${message} (blocked in strict mode)`, source: "hooks:writeGuard" }
      }
      return { warn: message, source: "hooks:writeGuard" }
    }

    return {}
  }
}

export function createWriteGuardAfter(options: WriteGuardOptions = {}): LegacyHookHandler {
  return (input) => {
    const tool = input.tool ?? ""
    const rawPath = input.params?.path as string | undefined
    const path = rawPath ? canonicalPath(rawPath, options.cwd) : undefined
    const readFiles = options.readFiles ?? writeGuardReadFiles

    if (tool === "read_file" && path && input.result?.success) {
      readFiles.add(path)
    }

    return {}
  }
}

export const writeGuardBefore: LegacyHookHandler = createWriteGuardBefore()

/** After-hook: tracks successful file reads into the read-set. */
export const writeGuardAfter: LegacyHookHandler = createWriteGuardAfter()

/** Reset the tracked read-files set (e.g. on new session). */
export function resetWriteGuard() {
  writeGuardReadFiles.clear()
}

// ── Backward compat: old writeGuard as a combined export (deprecated) ──
/** @deprecated Use writeGuardBefore + writeGuardAfter instead. */
export const writeGuard: LegacyHookHandler = async (input) => {
  const before = await writeGuardBefore(input)
  if (before.blocked || before.warn) return before
  return writeGuardAfter(input)
}

/**
 * Journal veto — 铁律一票否决 hook.
 * 写操作后自动检查日记铁律。若触发 block 级别违规，
 * 返回 blocked:true + 回溯指令，强制 Agent 重新规划。
 *
 * 这就是"元 Agent 仲裁"的落地实现：
 * 代码能跑 ≠ 通过，铁律是最后一道防线。
 */
export function createJournalGuard(projectRoot: string): LegacyHookHandler {
  const engine = new JournalEngine(projectRoot)
  const changedFiles = new Set<string>()

  return (input) => {
    const tool = input.tool ?? ""
    const path = input.params?.path as string | undefined

    // Track all written files
    if ((tool === "write_file" || tool === "edit_file" || tool === "edit_fim") && path) {
      changedFiles.add(path)
    }

    // Check only on write-ish operations that succeeded
    if (
      input.result?.success &&
      (tool === "write_file" || tool === "edit_file" || tool === "edit_fim" || tool === "shell")
    ) {
      const ctx = {
        projectRoot,
        changedFiles: [...changedFiles],
        toolName: tool,
        params: input.params ?? {},
        result: input.result,
        recentMessages: [],
      }
      const violations = engine.check(ctx)
      if (violations.length > 0) {
        const report = engine.formatViolations(violations)
        if (engine.hasBlockingViolation(violations)) {
          return {
            blocked: true,
            result: {
              success: false,
              content: `操作被元 Agent 一票否决。${report}`,
            },
            source: "hooks:journalGuard",
          }
        }
        // Warning only — append to result
        return {
          result: {
            success: true,
            content: input.result.content + report,
          },
          source: "hooks:journalGuard",
        }
      }
    }

    return {}
  }
}
